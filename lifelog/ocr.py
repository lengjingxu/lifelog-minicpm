"""用 MiniCPM-OCR 从照片里抽文字（截屏、票据、路牌、招牌）。

OCR 结果直接写回描述记录（prompt_version='describe-v1'）的 ocr_text 字段，
不新增行，避免同��张照片在检索里出现重复。
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from . import config, db, models

PROMPT_VERSION = "describe-v1"

PROMPT = (
    "请识别图片中的所有文字并按阅读顺序输出。"
    "如果图片里有表格，用 markdown 表格保留结构；如果有票据/订单，"
    "额外列出：金额、日期、商户、票号。"
    "如果图片里没有可读文字，只回复四个字：无可读文字。"
)


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def run_ocr(model_key: str = "minicpm-ocr-1.0", limit: int | None = None,
            since_day=None, until_day=None, tag: str | None = None) -> dict:
    db.init_db()
    stats = {"todo": 0, "ok": 0, "empty": 0, "failed": 0}
    query = (
        "SELECT a.id, a.path, a.day, c.tags FROM assets a "
        "JOIN captions c ON c.asset_id = a.id AND c.prompt_version = 'describe-v1' "
        "WHERE a.kind='image' AND (c.ocr_text IS NULL OR c.ocr_text = '')"
    )
    params: list = []
    if since_day:
        query += " AND a.day >= ?"
        params.append(since_day)
    if until_day:
        query += " AND a.day <= ?"
        params.append(until_day)
    query += " ORDER BY a.day, a.path"
    with db.session() as con:
        rows = [dict(row) for row in con.execute(query, params).fetchall()]

    todo = rows
    if tag:
        wanted = [t.strip() for t in tag.split(",") if t.strip()]
        todo = [item for item in todo
                if any(t in db.jload(item.get("tags")) for t in wanted)]
    if limit:
        todo = todo[:int(limit)]
    stats["todo"] = len(todo)
    if not todo:
        return stats

    with models.Server(model_key) as server:
        for index, asset in enumerate(todo, 1):
            path = Path(asset["path"])
            if not path.exists():
                continue
            try:
                text = server.chat(PROMPT, images=[path], max_tokens=700, timeout=300)
            except Exception as exc:
                stats["failed"] += 1
                print(f"[{index}/{len(todo)}] OCR 失败 {path.name}: {exc}")
                continue
            text = text.strip()
            if not text or "无可读文字" in text:
                stats["empty"] += 1
                value = ""
            else:
                stats["ok"] += 1
                value = text[:4000]
            with db.session() as con:
                con.execute(
                    "UPDATE captions SET ocr_text=? WHERE asset_id=? AND prompt_version=?",
                    (value, asset["id"], PROMPT_VERSION),
                )
                con.execute("DELETE FROM caption_fts WHERE asset_id=?", (asset["id"],))
                row = con.execute(
                    "SELECT caption, tags, place, activity FROM captions "
                    "WHERE asset_id=? AND prompt_version=? LIMIT 1",
                    (asset["id"], PROMPT_VERSION)).fetchone()
                if row:
                    con.execute(
                        "INSERT INTO caption_fts (asset_id, caption, tags, place, activity, ocr_text) "
                        "VALUES (?,?,?,?,?,?)",
                        (asset["id"], row["caption"] or "", row["tags"] or "",
                         row["place"] or "", row["activity"] or "", value),
                    )
            if index % 20 == 0 or index == len(todo):
                print(f"[{index}/{len(todo)}] 已抽字 {stats['ok']} 张")
    return stats
