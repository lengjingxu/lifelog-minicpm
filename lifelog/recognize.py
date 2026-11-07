"""识别现场：把照片识别过程做成可观看的事件流。

两种会话：
    SimSession  —— 回放库中已有描述的照片，按真实测速节奏模拟并发识别（无需模型）；
    LiveSession —— 预留：真实调 run_caption（llama.cpp 在位后启用）。

事件写入内存 ring buffer，前端轮询 /api/live/events?cursor=N 增量拉取。
"""
from __future__ import annotations

import json
import random
import threading
import time
from pathlib import Path

from . import config, db

TEMPLATE = Path(__file__).resolve().parent / "assets" / "live.html"

# 实测节奏（README：4 并发 ~1.2 张/秒，单张中位 ~3.3s）——模拟就按这个分布
SIM_ELAPSED_RANGE = (2.4, 4.6)  # 秒
DEFAULT_CONCURRENCY = 4


def _now_ms() -> int:
    return int(time.time() * 1000)


class Session:
    """一次识别会话的公共骨架：事件队列 + 游标 + 状态。"""

    def __init__(self, mode: str, total: int, concurrency: int, extra: dict | None = None):
        self.mode = mode
        self.total = total
        self.concurrency = concurrency
        self.extra = extra or {}
        self.status = "running"          # running | done | stopped
        self.started_ms = _now_ms()
        self.finished_ms: int | None = None
        self.done_count = 0
        self._events: list[dict] = []
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self.thread: threading.Thread | None = None

    # ---- 事件与状态 -------------------------------------------------
    def push(self, event: dict) -> None:
        with self._lock:
            event["seq"] = len(self._events) + 1
            self._events.append(event)

    def events_since(self, cursor: int) -> list[dict]:
        with self._lock:
            return self._events[cursor:], len(self._events)

    def state(self) -> dict:
        elapsed_ms = (self.finished_ms or _now_ms()) - self.started_ms
        rate = round(self.done_count / (elapsed_ms / 1000), 2) if elapsed_ms > 400 else None
        return {
            "mode": self.mode,
            "status": self.status,
            "total": self.total,
            "done": self.done_count,
            "concurrency": self.concurrency,
            "elapsed_ms": elapsed_ms,
            "rate": rate,
            "extra": self.extra,
        }

    def finish(self, status: str = "done") -> None:
        self.status = status
        self.finished_ms = _now_ms()
        self.push({"type": "session_" + status,
                   "done": self.done_count, "total": self.total})

    def stop(self) -> None:
        self._stop.set()

    # ---- 子类实现 ---------------------------------------------------
    def run(self) -> None:  # pragma: no cover - 由子类覆盖
        raise NotImplementedError


class SimSession(Session):
    """回放：照片来自库里已识别的资产，标签/描述是真的，节奏是模拟的。"""

    def __init__(self, photos: list[dict], concurrency: int, speed: float):
        super().__init__("sim", len(photos), concurrency,
                         {"speed": speed, "label": "回放模式 · MiniCPM 实测节奏"})
        self.photos = list(photos)
        self.speed = max(0.25, speed)

    def run(self) -> None:
        queue = list(self.photos)
        random.shuffle(queue)

        def worker(slot: int) -> None:
            while not self._stop.is_set():
                with self._lock:
                    if not queue:
                        return
                    photo = queue.pop()
                self.push({"type": "start", "asset_id": photo["id"], "slot": slot})
                elapsed = random.uniform(*SIM_ELAPSED_RANGE)
                if self._stop.wait(elapsed / self.speed):
                    return
                self.done_count += 1
                self.push({
                    "type": "done", "asset_id": photo["id"], "slot": slot,
                    "elapsed_ms": int(elapsed * 1000),
                    "tags": photo.get("tags") or [],
                    "caption": photo.get("caption") or "",
                })

        threads = [threading.Thread(target=worker, args=(i,), daemon=True)
                   for i in range(self.concurrency)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.finish("stopped" if self._stop.is_set() else "done")


class LiveSession(Session):
    """真实识别：llama.cpp 在位后启用。事件来自 run_caption 的 on_result 回调。"""

    def __init__(self, total: int, concurrency: int, model_key: str,
                 sample: int | None, count: int | None):
        super().__init__("live", total, concurrency,
                         {"model": model_key, "label": "真实推理 · llama.cpp"})
        self.model_key = model_key
        self.sample = sample
        self.count = count

    def run(self) -> None:  # pragma: no cover - 依赖 llama-server
        from . import caption

        def on_result(asset: dict, data: dict, ok: bool, elapsed_ms: float) -> None:
            self.done_count += 1
            seq = len(self._events) + 1
            self.push({
                "seq": seq, "type": "done", "asset_id": asset["id"], "slot": 0,
                "elapsed_ms": int(elapsed_ms), "tags": data.get("tags") or [],
                "caption": data.get("caption") or "",
            })

        try:
            caption.run_caption(self.model_key, limit=self.count,
                                sample=self.sample, concurrency=self.concurrency,
                                on_result=on_result)
        except Exception as exc:
            self.push({"seq": len(self._events) + 1, "type": "error", "message": str(exc)})
        self.finish("done")


# ---------------------------------------------------------------- 管理器

_lock = threading.Lock()
_session: Session | None = None


def current() -> Session | None:
    return _session


def _sim_photos(count: int | None) -> list[dict]:
    db.init_db()
    with db.session() as con:
        rows = con.execute(
            """SELECT a.id, c.caption, c.tags
               FROM assets a JOIN current_caption c ON c.asset_id = a.id
               WHERE c.status = 'ok' AND a.kind = 'image'
               ORDER BY RANDOM() LIMIT ?""",
            (count or 500,),
        ).fetchall()
    return [{"id": r["id"], "caption": r["caption"] or "",
             "tags": db.jload(r["tags"]) or []} for r in rows]


def start(mode: str = "sim", count: int | None = 40, concurrency: int = DEFAULT_CONCURRENCY,
          speed: float = 2.0) -> dict:
    """启动一次会话；已有会话未结束时拒绝。

    返回 photos（本次会话的照片队列，含缩略图地址），前端据此铺「待识别堆」，
    保证事件里的 asset_id 都能在堆里找到对应元素。
    """
    global _session
    with _lock:
        if _session and _session.status == "running":
            return {"ok": False, "error": "会话进行中，请先停止"}
        photos = []
        if mode == "sim":
            photos = _sim_photos(count)
            if not photos:
                return {"ok": False, "error": "库里没有已识别的照片，先跑一次 caption"}
            session = SimSession(photos, concurrency, speed)
        elif mode == "live":
            from . import caption as caption_mod
            todo = caption_mod.pending_assets("minicpm-v-4.7-1b", caption_mod.PROMPT_VERSION,
                                              limit=count)
            session = LiveSession(len(todo), concurrency, "minicpm-v-4.7-1b",
                                  sample=None, count=count)
        else:
            return {"ok": False, "error": f"未知模式 {mode}"}
        session.thread = threading.Thread(target=session.run, daemon=True)
        _session = session
        session.thread.start()
        payload = [{"id": p["id"], "thumb": f"/thumb/{p['id']}"} for p in photos]
        return {"ok": True, "state": session.state(), "photos": payload}


def session_photos() -> list[dict]:
    """当前（或最近一次）会话的照片队列，供前端刷新后接入现场。"""
    if isinstance(_session, SimSession):
        return [{"id": p["id"], "thumb": f"/thumb/{p['id']}"} for p in _session.photos]
    return []


def stop() -> dict:
    with _lock:
        if not _session or _session.status != "running":
            return {"ok": False, "error": "没有进行中的会话"}
        _session.stop()
        return {"ok": True}


def state() -> dict:
    return _session.state() if _session else {"mode": None, "status": "idle"}


def events(cursor: int = 0) -> dict:
    if not _session:
        return {"events": [], "cursor": 0}
    items, length = _session.events_since(max(0, cursor))
    return {"events": items, "cursor": length}


# ---------------------------------------------------------------- 页面

def build_page_data() -> dict:
    """live 页初始注入：照片清单 + 17 类桶定义。"""
    db.init_db()
    with db.session() as con:
        rows = con.execute(
            """SELECT a.id, c.caption, c.tags
               FROM assets a JOIN current_caption c ON c.asset_id = a.id
               WHERE c.status = 'ok' AND a.kind = 'image'
               ORDER BY a.taken_at, a.path LIMIT 600"""
        ).fetchall()
    photos = [{"id": r["id"], "thumb": f"/thumb/{r['id']}",
               "tags": db.jload(r["tags"]) or [], "caption": r["caption"] or ""}
              for r in rows]
    return {
        "buckets": config.TAXONOMY_ORDER,
        "photos": photos,
        "meta": {
            "model": "MiniCPM-V-4.7-1B",
            "concurrency": DEFAULT_CONCURRENCY,
            "measured_rate": 1.2,
        },
    }


def render() -> str:
    template = TEMPLATE.read_text(encoding="utf-8")
    payload = json.dumps(build_page_data(), ensure_ascii=False)
    return template.replace('{"placeholder":true}', payload)
