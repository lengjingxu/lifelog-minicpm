"""待清理清单：只记 id，不动文件、不删 assets 行。"""
from __future__ import annotations

import time

from . import config, db

SCHEMA = """
CREATE TABLE IF NOT EXISTS cleanup_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id TEXT NOT NULL UNIQUE,
    added_at TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'space'
);
CREATE INDEX IF NOT EXISTS idx_cleanup_queue_added ON cleanup_queue(added_at);
"""

MAX_IDS = 2000


def _now() -> str:
    return str(int(time.time()))


def _ensure(con) -> None:
    con.executescript(SCHEMA)


def _totals(con) -> tuple[int, int]:
    row = con.execute(
        "SELECT count(*), COALESCE(sum(a.size),0) FROM cleanup_queue q "
        "JOIN assets a ON a.id = q.asset_id"
    ).fetchone()
    return row[0] or 0, row[1] or 0


def list_queue() -> dict:
    con = db.connect()
    try:
        _ensure(con)
        rows = con.execute(
            "SELECT q.asset_id, q.added_at, q.source, a.path, a.day, a.taken_at, a.kind, a.size "
            "FROM cleanup_queue q JOIN assets a ON a.id = q.asset_id ORDER BY q.id DESC"
        ).fetchall()
        count, total = _totals(con)
    finally:
        con.close()
    items = [
        {
            "asset_id": r[0], "added_at": r[1], "source": r[2], "path": r[3],
            "day": r[4], "taken_at": r[5], "kind": r[6], "size": r[7],
        }
        for r in rows
    ]
    return {"items": items, "count": count, "bytes": total}


def add_to_queue(ids: list[str], source: str = "space") -> dict:
    ids = list(dict.fromkeys(i.strip() for i in ids if i and i.strip()))[:MAX_IDS]
    con = db.connect()
    try:
        _ensure(con)
        marks = ",".join("?" for _ in ids) or "NULL"
        cur = con.execute(
            "INSERT OR IGNORE INTO cleanup_queue (asset_id, added_at, source) "
            f"SELECT id, ?, ? FROM assets WHERE id IN ({marks})",
            [_now(), source or "space", *ids],
        )
        con.commit()
        changed = cur.rowcount
        count, total = _totals(con)
    finally:
        con.close()
    return {"changed": changed, "count": count, "bytes": total}


def remove_from_queue(ids: list[str]) -> dict:
    ids = list(dict.fromkeys(i.strip() for i in ids if i and i.strip()))[:MAX_IDS]
    con = db.connect()
    try:
        _ensure(con)
        marks = ",".join("?" for _ in ids) or "NULL"
        cur = con.execute(f"DELETE FROM cleanup_queue WHERE asset_id IN ({marks})", ids)
        con.commit()
        changed = cur.rowcount
        count, total = _totals(con)
    finally:
        con.close()
    return {"changed": changed, "count": count, "bytes": total}


def drop_ids(ids: list[str]) -> int:
    """真实清理后同步移除清单行；只动 cleanup_queue。"""
    return remove_from_queue(ids)["changed"]


def summary() -> dict:
    con = db.connect()
    try:
        has_queue = con.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='cleanup_queue'"
        ).fetchone()
        photos = con.execute(
            "SELECT count(*), COALESCE(sum(size),0) FROM assets WHERE kind IS NULL OR kind != 'video'"
        ).fetchone()
        videos = con.execute(
            "SELECT count(*), COALESCE(sum(size),0) FROM assets WHERE kind = 'video'"
        ).fetchone()
        big = con.execute(
            "SELECT count(*), COALESCE(sum(size),0) FROM assets "
            "WHERE kind = 'video' AND size >= 104857600"
        ).fetchone()
        queue = _totals(con) if has_queue else (0, 0)
    finally:
        con.close()
    return {
        "assets": (photos[0] or 0) + (videos[0] or 0),
        "bytes": (photos[1] or 0) + (videos[1] or 0),
        "photos": {"count": photos[0] or 0, "bytes": photos[1] or 0},
        "videos": {"count": videos[0] or 0, "bytes": videos[1] or 0},
        "big_videos": {"count": big[0] or 0, "bytes": big[1] or 0},
        "queue_count": queue[0],
        "queue_bytes": queue[1],
    }

