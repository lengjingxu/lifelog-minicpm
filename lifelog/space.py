"""待清理清单：只记 id，不动文件、不删 assets 行。"""
from __future__ import annotations

import hashlib
import os
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



# ---------- 视角统计与分组（口径与 query_assets 的 view 过滤一致） ----------

DUP_SQL = """
SELECT count(*) FROM (
    SELECT size FROM assets
    WHERE kind = 'image' AND size IS NOT NULL
    GROUP BY size HAVING count(*) > 1
)"""

SCREENSHOT_WHERE = """
((a.path LIKE '%Screenshot%' OR a.path LIKE '%screenshot%'
  OR a.path LIKE '%截屏%' OR a.path LIKE '%屏幕%')
 OR c.scene LIKE '%屏幕%' OR c.scene LIKE '%截屏%'
 OR c.tags LIKE '%屏幕截图%' OR c.tags LIKE '%截屏%')"""


DUP_WHERE = (
    "a.kind = 'image' AND a.size IS NOT NULL AND a.size IN ("
    "    SELECT size FROM assets WHERE kind = 'image' AND size IS NOT NULL"
    "    GROUP BY size HAVING count(*) > 1)"
)


def _filter_sql(view: str) -> str:
    if view == "dup":
        return DUP_WHERE
    if view == "screenshot":
        return SCREENSHOT_WHERE
    if view == "video":
        return "a.kind = 'video'"
    if view == "photo":
        return "(a.kind IS NULL OR a.kind != 'video')"
    return "1=1"


def _count(con, view: str) -> tuple[int, int]:
    if view == "large":
        row = con.execute("SELECT count(*), COALESCE(sum(size),0) FROM assets").fetchone()
        return row[0] or 0, row[1] or 0
    row = con.execute(
        "SELECT count(*), COALESCE(sum(a.size),0) FROM assets a "
        "LEFT JOIN captions c ON c.rowid = ("
        "    SELECT rowid FROM captions c2 WHERE c2.asset_id = a.id ORDER BY c2.created_at DESC LIMIT 1) "
        f"WHERE {_filter_sql(view)}"
    ).fetchone()
    return row[0] or 0, row[1] or 0


def views() -> dict:
    """五个视角的数量与占用。口径与 Rust 的 query_assets(view) 保持一致。"""
    con = db.connect()
    try:
        result = {}
        for view in ("large", "video", "photo", "screenshot", "dup"):
            count, total = _count(con, view)
            result[view] = {"count": count, "bytes": total}
        result["dup"]["groups"] = con.execute(DUP_SQL).fetchone()[0] or 0
    finally:
        con.close()
    result["dup"]["rule"] = "同 size 同 kind"
    result["screenshot"]["rule"] = "路径 + scene/tags"
    return result


def _dup_groups(con) -> list[dict]:
    """重复图按 size 分组；组内把 size 最大的一张当 keeper（其实同组同 size，按时间稳定挑）。"""
    rows = con.execute(
        "SELECT size, count(*) AS n FROM assets "
        "WHERE kind = 'image' AND size IS NOT NULL "
        "GROUP BY size HAVING n > 1 ORDER BY n DESC, size DESC"
    ).fetchall()
    groups = []
    for size, count in rows:
        members = con.execute(
            "SELECT id FROM assets WHERE kind = 'image' AND size = ? ORDER BY taken_at DESC, id"
            " LIMIT 50",
            (size,),
        ).fetchall()
        ids = [r[0] for r in members]
        groups.append({
            "key": f"dup:{size}",
            "label": "同 %.1f MB" % (size / 1024 / 1024),
            "count": count,
            "ids": ids,
            "keep": ids[0] if ids else None,
        })
    return groups


def _screenshot_groups(con) -> list[dict]:
    # 真实库里截图分散在 /Users/.../photos/YYYYMM/ 和 /Volumes/... 下：
    # 先取 /photos/ 后面那一层，没有就退回父目录名，避免整盘都归成 "Volumes"。
    rows = con.execute(
        "SELECT a.path, a.size FROM assets a "
        "LEFT JOIN captions c ON c.rowid = ("
        "    SELECT rowid FROM captions c2 WHERE c2.asset_id = a.id ORDER BY c2.created_at DESC LIMIT 1) "
        f"WHERE {SCREENSHOT_WHERE} ORDER BY a.size DESC"
    ).fetchall()
    buckets: dict[str, list] = {}
    for path, size in rows:
        relative = path or ""
        marker = relative.find("/photos/")
        if marker >= 0:
            relative = relative[marker + len("/photos/"):]
        parts = [part for part in relative.split("/") if part]
        if marker >= 0 and len(parts) > 1:
            label = parts[0]
        else:
            label = os.path.basename(os.path.dirname(relative)) or "其他"
        buckets.setdefault(label, []).append((path, size))
    return [
        {"key": f"screenshot:{label}", "label": label, "count": len(items),
         "bytes": sum(size or 0 for _p, size in items)}
        for label, items in sorted(buckets.items(), key=lambda kv: -len(kv[1]))
    ]


def groups(view: str) -> dict:
    """视角分组：重复图按 size（组内 keeper 不勾），截屏按来源目录。"""
    con = db.connect()
    try:
        if view == "dup":
            items = _dup_groups(con)
        elif view == "screenshot":
            items = _screenshot_groups(con)
        else:
            items = []
    finally:
        con.close()
    return {"view": view, "groups": items}


def versions() -> dict:
    """库内容指纹：前端的内存缓存（重复组、待清理缩略图）用它判断是否需要重拉。"""
    con = db.connect()
    try:
        row = con.execute(
            "SELECT count(*), COALESCE(sum(size),0), COALESCE(max(created_at), '') FROM assets"
        ).fetchone()
    finally:
        con.close()
    raw = "|".join(str(part) for part in row)
    return {
        "assets": row[0] or 0,
        "bytes": row[1] or 0,
        "version": hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16],
    }

