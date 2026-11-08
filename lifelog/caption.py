"""用 MiniCPM 逐张理解照片，产出结构化描述。"""
from __future__ import annotations

import json
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path

from . import config, db, models

PROMPT_VERSION = "describe-v1"

PROMPT = (
    "你在帮一个人整理他的私人相册，让 AI 之后能读懂他的生活。"
    "请用中文客观描述这张照片，只输出一个 JSON 对象，字段为："
    '{"caption":"一句话描述这张照片里发生了什么",'
    '"scene":"场景，如 家/餐厅/街道/办公室/户外/旅途",'
    '"people":"出现的人，如 独自一人/与家人/与朋友/多人群像/难以辨认，没有则写 无",'
    '"place":"可辨认的地点线索，没有则写 无",'
    '"activity":"正在进行的事情，如 吃饭/赶路/办公/运动/拍照/购物/休息",'
    '"mood":"整体氛围，2-4 个字",'
    '"tags":["从给定类别中选 1-3 个，必须用中文"]}。'
    "类别：" + "、".join(config.TAGS) + "。"
    "不要输出 JSON 以外的任何内容。"
)


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _extract_block(text: str) -> str | None:
    """截出第一个完整的 {...} 块。"""
    start = text.find("{")
    if start < 0:
        return None
    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(text)):
        char = text[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == chr(92):
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return text[start:index + 1]
    return None


def _extract_partial(text: str) -> str | None:
    """输出被 max_tokens 截断时，把没闭合的块补全到可解析。"""
    start = text.find("{")
    if start < 0:
        return None
    body = text[start:]
    tail = ""
    if body.count(chr(34)) % 2 == 1:
        tail += chr(34)
    if body.count("[") > body.count("]"):
        tail += "]"
    if body.count("{") > body.count("}"):
        tail += "}"
    return body + tail

def _add_missing_commas(block: str) -> str:
    """小模型偶尔在两个字段之间漏掉逗号：在字符串结束后紧跟下一个键时补上。"""
    out = []
    in_string = False
    escaped = False
    index = 0
    length = len(block)
    while index < length:
        char = block[index]
        out.append(char)
        if in_string:
            if escaped:
                escaped = False
            elif char == chr(92):
                escaped = True
            elif char == '"':
                in_string = False
                probe = index + 1
                while probe < length and block[probe] in " \n\t":
                    probe += 1
                if probe < length and block[probe] == '"':
                    out.append(",")
            index += 1
            continue
        if char == '"':
            in_string = True
        index += 1
    return "".join(out)


def _string_field(block: str, key: str) -> str | None:
    marker = '"' + key + '"'
    pos = block.find(marker)
    if pos < 0:
        return None
    colon = block.find(":", pos + len(marker))
    if colon < 0:
        return None
    quote = block.find('"', colon + 1)
    if quote < 0:
        return None
    end = quote + 1
    while end < len(block):
        if block[end] == chr(92):
            end += 2
            continue
        if block[end] == '"':
            break
        end += 1
    return block[quote + 1:end]


def _tags_field(block: str) -> list[str]:
    marker = '"tags"'
    pos = block.find(marker)
    if pos < 0:
        return []
    start = block.find("[", pos)
    end = block.find("]", start) if start >= 0 else -1
    if start < 0 or end < 0:
        return []
    inner = block[start + 1:end]
    tags = []
    index = 0
    while index < len(inner):
        if inner[index] == '"':
            close = index + 1
            while close < len(inner) and inner[close] != '"':
                close += 1
            tags.append(inner[index + 1:close])
            index = close + 1
            continue
        index += 1
    return tags


def parse_json_object(text: str) -> dict | None:
    """解析模型输出：严格 JSON → 补逗号 → 逐字段兜底。"""
    text = text.strip()
    block = _extract_block(text) or _extract_partial(text)
    if not block:
        return None
    try:
        return json.loads(block)
    except ValueError:
        pass
    try:
        return json.loads(_add_missing_commas(block))
    except ValueError:
        pass
    data = {}
    for key in ("caption", "scene", "people", "place", "activity", "mood"):
        value = _string_field(block, key)
        if value:
            data[key] = value
    data["tags"] = _tags_field(block)
    return data if data.get("caption") else None


def clean_tags(value) -> list[str]:
    if isinstance(value, str):
        value = [value]
    tags = []
    for item in value or []:
        tag = str(item).strip()
        if not tag:
            continue
        if tag in config.TAGS:
            tags.append(tag)
        else:
            for known in config.TAGS:
                if known in tag and known not in tags:
                    tags.append(known)
                    break
    return tags[:3]


def pending_assets(model: str, prompt_version: str = PROMPT_VERSION, limit: int | None = None,
                   since_day: str | None = None, until_day: str | None = None,
                   sample: int | None = None) -> list[dict]:
    query = """SELECT a.id, a.path, a.day, a.taken_at FROM assets a
               LEFT JOIN captions c
                 ON c.asset_id = a.id AND c.model = ? AND c.prompt_version = ?
               WHERE (c.asset_id IS NULL OR c.status != 'ok') AND a.kind = 'image'"""
    params: list = [model, prompt_version]
    if since_day:
        query += " AND a.day >= ?"
        params.append(since_day)
    if until_day:
        query += " AND a.day <= ?"
        params.append(until_day)
    query += " ORDER BY a.day, a.path"
    with db.session() as con:
        rows = [dict(row) for row in con.execute(query, params).fetchall()]
    if sample and len(rows) > sample:
        step = len(rows) / sample
        rows = [rows[int(i * step)] for i in range(sample)]
    elif limit:
        rows = rows[:int(limit)]
    return rows


def store_caption(con, asset_id: str, model: str, model_version: str, data: dict,
                  raw: str, prompt_version: str = PROMPT_VERSION, status: str = "ok") -> None:
    con.execute(
        """INSERT INTO captions (asset_id, model, model_version, prompt_version, caption, scene,
                                people, place, activity, mood, tags, raw, status, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(asset_id, model, prompt_version) DO UPDATE SET
             caption=excluded.caption, scene=excluded.scene, people=excluded.people,
             place=excluded.place, activity=excluded.activity, mood=excluded.mood,
             tags=excluded.tags, raw=excluded.raw, status=excluded.status,
             created_at=excluded.created_at""",
        (asset_id, model, model_version, prompt_version,
         data.get("caption"), data.get("scene"), data.get("people"), data.get("place"),
         data.get("activity"), data.get("mood"), db.jdump(clean_tags(data.get("tags"))),
         raw, status, now_iso()),
    )
    con.execute("DELETE FROM caption_fts WHERE asset_id = ?", (asset_id,))
    con.execute(
        "INSERT INTO caption_fts (asset_id, caption, tags, place, activity, ocr_text) VALUES (?,?,?,?,?,?)",
        (asset_id, data.get("caption") or "", db.jdump(clean_tags(data.get("tags"))),
         data.get("place") or "", data.get("activity") or "", data.get("ocr_text") or ""),
    )


def run_caption(model_key: str, limit: int | None = None, since_day: str | None = None,
                until_day: str | None = None, max_side: int = 1024,
                sample: int | None = None, concurrency: int = 1,
                on_result: Callable | None = None) -> dict:
    """对尚未描述的照片逐张跑 MiniCPM。可重复运行，自动续跑。

    on_result(asset, data, ok, elapsed_ms)：每张完成时回调（供实时可视化等场景）。
    """
    import time as _time

    db.init_db()
    model_version = config.MODELS[model_key]["title"]
    todo = pending_assets(model_key, PROMPT_VERSION, limit, since_day, until_day, sample)
    stats = {"todo": len(todo), "ok": 0, "failed": 0, "skipped": 0}
    if not todo:
        return stats

    def report(asset: dict, data: dict, ok: bool, elapsed_ms: float) -> None:
        if on_result is None:
            return
        try:
            on_result(asset, data, ok, elapsed_ms)
        except Exception:
            pass

    def describe(asset: dict) -> tuple[dict, dict | None, str]:
        path = Path(asset["path"])
        if not path.exists():
            return asset, None, ""
        try:
            raw = server.chat(PROMPT, images=[path], max_tokens=300, timeout=300)
        except Exception as exc:
            return asset, None, f"请求失败 {path.name}: {exc}"
        return asset, parse_json_object(raw) or {}, raw[:2000]

    def save(asset: dict, data: dict, raw: str, elapsed_ms: float = 0.0) -> None:
        if raw.startswith("请求失败"):
            stats["failed"] += 1
            print(raw)
            report(asset, {}, False, elapsed_ms)
            return
        if not data.get("caption"):
            stats["failed"] += 1
            with db.session() as con:
                store_caption(con, asset["id"], model_key, model_version, {}, raw,
                              status="unparsed")
            report(asset, data, False, elapsed_ms)
            return
        with db.session() as con:
            store_caption(con, asset["id"], model_key, model_version, data, raw)
        stats["ok"] += 1
        report(asset, data, True, elapsed_ms)

    with models.Server(model_key, parallel=concurrency) as server:
        if concurrency > 1:
            from concurrent.futures import ThreadPoolExecutor, as_completed

            def timed_describe(asset: dict):
                t0 = _time.perf_counter()
                result = describe(asset)
                return result, (_time.perf_counter() - t0) * 1000

            with ThreadPoolExecutor(max_workers=concurrency) as pool:
                futures = [pool.submit(timed_describe, asset) for asset in todo]
                for index, future in enumerate(as_completed(futures), 1):
                    (asset, data, raw), elapsed_ms = future.result()
                    save(asset, data, raw, elapsed_ms)
                    if index % 20 == 0 or index == len(todo):
                        print(f"[{index}/{len(todo)}] 已完成 {stats['ok']} 张")
        else:
            for index, asset in enumerate(todo, 1):
                t0 = _time.perf_counter()
                asset, data, raw = describe(asset)
                elapsed_ms = (_time.perf_counter() - t0) * 1000
                save(asset, data, raw, elapsed_ms)
                if index % 20 == 0 or index == len(todo):
                    print(f"[{index}/{len(todo)}] {data.get('caption', '')[:60]}")
    return stats
