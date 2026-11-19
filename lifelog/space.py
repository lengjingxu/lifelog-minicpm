"""待清理清单：只记 id，不动文件、不删 assets 行。"""
from __future__ import annotations

import hashlib
import sqlite3
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


def add_all_dup_candidates(source: str = "space") -> dict:
    """把所有重复组里 keeper 以外的 id 一次性写进 cleanup_queue。

    单条 INSERT…SELECT 完成，不经过前端逐组请求；返回写后总数。
    """
    con = db.connect()
    try:
        _ensure(con)
        cur = con.execute(
            "INSERT OR IGNORE INTO cleanup_queue (asset_id, added_at, source) "
            "SELECT m.asset_id, ?, ? FROM dup_groups g "
            "JOIN dup_members m ON m.group_id = g.id "
            "JOIN assets a ON a.id = m.asset_id "
            "WHERE m.asset_id != g.keeper_id",
            [_now(), source or "space"],
        )
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
        return "a.id IN (SELECT asset_id FROM dup_members)"
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
        result["dup"]["groups"] = con.execute("SELECT count(*) FROM dup_groups").fetchone()[0] or 0
        # 可回收：组内 keeper 以外的成员体积合计。
        result["dup"]["reclaim_count"] = con.execute(
            "SELECT count(*) FROM dup_groups g JOIN dup_members m ON m.group_id = g.id "
            "WHERE m.asset_id != g.keeper_id"
        ).fetchone()[0] or 0
        result["dup"]["reclaim"] = con.execute(
            "SELECT COALESCE(sum(a.size),0) FROM dup_groups g "
            "JOIN dup_members m ON m.group_id = g.id "
            "JOIN assets a ON a.id = m.asset_id WHERE m.asset_id != g.keeper_id"
        ).fetchone()[0] or 0
        result["dup"]["ready"] = _dup_truth(con)
    finally:
        con.close()
    result["dup"]["rule"] = "dhash 指纹（l0 字节 / l1 像素 / burst 连拍）"
    result["screenshot"]["rule"] = "路径 + scene/tags"
    return result


# ---------- 真实去重表（dhash 跑完后才有内容） ----------

# reason 里可能叠加了多层判定：burst+l0、burst+l1…
REASON_LABELS = {
    "burst": "连拍",
    "l0": "字节相同",
    "l1": "像素近似",
}


def _reason_tiers(reason: str) -> list[str]:
    parts = [part.strip() for part in (reason or "").split("+") if part.strip()]
    return [part for part in parts if part in REASON_LABELS]


def _dup_truth(con) -> bool:
    """dup_groups / dup_members 都非空才算「指纹算完了」。"""
    try:
        groups = con.execute("SELECT count(*) FROM dup_groups").fetchone()[0] or 0
        members = con.execute("SELECT count(*) FROM dup_members").fetchone()[0] or 0
    except Exception:
        return False
    return groups > 0 and members > 0


def _table_exists(con, name: str) -> bool:
    row = con.execute(
        "SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?", (name,)
    ).fetchone()
    return row is not None


def _dup_groups(con, limit: int | None = None, offset: int = 0) -> list[dict]:
    """真实去重组。

    只返回 chip 需要的轻量字段：ids 数组有 12k 个，一次全给会让 JSON 涨到 1.2MB。
    真正要整组加入时走 dup_group_ids() 或 dup_all_candidates()。
    """
    sql = (
        "SELECT g.id, g.reason, g.keeper_id, "
        "       count(m.asset_id) AS n, "
        "       COALESCE(sum(a.size),0) AS bytes, "
        "       COALESCE(sum(CASE WHEN m.asset_id != g.keeper_id THEN a.size ELSE 0 END),0) AS reclaim "
        "FROM dup_groups g "
        "JOIN dup_members m ON m.group_id = g.id "
        "JOIN assets a ON a.id = m.asset_id "
        "GROUP BY g.id ORDER BY n DESC, g.id"
    )
    params: list = []
    if limit:
        sql += " LIMIT ? OFFSET ?"
        params.extend([int(limit), max(0, int(offset))])
    rows = con.execute(sql, params).fetchall()
    groups = []
    for group_id, reason, keeper, count, total_bytes, reclaim in rows:
        tiers = _reason_tiers(reason or "")
        groups.append({
            "key": f"dup:{group_id}",
            "label": "/".join(REASON_LABELS[tier] for tier in tiers) or (reason or "重复"),
            "reason": reason or "",
            "reasons": tiers,
            "count": count or 0,
            "bytes": total_bytes or 0,
            "reclaim_bytes": reclaim or 0,
            "keeper": keeper or None,
        })
    return groups


def dup_group_ids(con, group_id: int) -> list[str]:
    """按需取一组的成员：keeper 第一，其余按美学分从高到低。"""
    row = con.execute("SELECT keeper_id FROM dup_groups WHERE id = ?", (group_id,)).fetchone()
    if not row:
        return []
    keeper = row[0] or ""
    # 有评分表时组内按分数降序，让用户一眼看到最好的那张；
    # 没有评分表就退回原来的 distance 顺序，行为不变。
    score_join = (
        " LEFT JOIN asset_quality q ON q.asset_id = m.asset_id"
        if _table_exists(con, "asset_quality")
        else ""
    )
    order = ["CASE WHEN m.asset_id = ? THEN 0 ELSE 1 END"]
    if score_join:
        # 有评分表时按分数降序（无分垫底）；没有评分表时退回 distance。
        order.append("COALESCE(q.score, -1) DESC")
    order += ["m.distance IS NULL", "m.distance", "m.asset_id"]
    sql = "SELECT m.asset_id FROM dup_members m{} WHERE m.group_id = ? ORDER BY {}".format(
        score_join, ", ".join(order)
    )
    # 占位符顺序按 SQL 文本：先 WHERE 的 group_id，再 ORDER BY 的 keeper。
    members = con.execute(sql, (group_id, keeper)).fetchall()
    return [member[0] for member in members]


def dup_all_candidates(con) -> list[str]:
    """所有重复组里 keeper 以外的 asset_id（「全部加入待清理」用）。"""
    rows = con.execute(
        "SELECT m.asset_id FROM dup_groups g JOIN dup_members m ON m.group_id = g.id "
        "WHERE m.asset_id != g.keeper_id ORDER BY m.asset_id"
    ).fetchall()
    return [row[0] for row in rows]


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


DUP_CHIP_LIMIT = 30


def groups(view: str, limit: int | None = None, offset: int = 0,
           group_id: int | None = None) -> dict:
    """视角分组。

    dup 默认只返回每组的轻量字段（不带 ids）；给了 group_id 就只返回这一组并带上 ids。
    screenshot 按来源目录分组。
    """
    con = db.connect()
    total = None
    try:
        if view == "dup":
            total = con.execute("SELECT count(*) FROM dup_groups").fetchone()[0] or 0
            if group_id is not None:
                ids = dup_group_ids(con, group_id)
                items = []
                if ids:
                    row = con.execute(
                        "SELECT reason, keeper_id FROM dup_groups WHERE id = ?", (group_id,),
                    ).fetchone()
                    reason = (row[0] if row else "") or ""
                    keeper = (row[1] if row else "") or ""
                    tiers = _reason_tiers(reason)
                    items = [{
                        "key": f"dup:{group_id}",
                        "label": "/".join(REASON_LABELS[t] for t in tiers) or (reason or "重复"),
                        "reason": reason,
                        "reasons": tiers,
                        "count": len(ids),
                        "keeper": keeper or ids[0],
                        "ids": ids,
                    }]
            else:
                items = _dup_groups(con, limit=limit or DUP_CHIP_LIMIT, offset=offset)
        elif view == "screenshot":
            items = _screenshot_groups(con)
        else:
            items = []
    finally:
        con.close()
    return {"view": view, "groups": items, "total": total}


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


def import_summary() -> dict:
    """导入结束后的总结：这次进了什么、库里现在有什么、建议清理什么。

    只读聚合，不改任何数据。数字直接来自 assets / merged_caption / dup_groups，
    所以和「图库清理」页看到的一致，不会出现两处对不上。
    """
    con = db.connect()
    try:
        def one(sql: str, params=()):
            row = con.execute(sql, params).fetchone()
            return row[0] if row else 0

        total = one("SELECT count(*) FROM assets")
        images = one("SELECT count(*) FROM assets WHERE kind != 'video'")
        videos = one("SELECT count(*) FROM assets WHERE kind = 'video'")
        bytes_total = one("SELECT COALESCE(sum(size),0) FROM assets")
        screenshots = one(
            "SELECT count(*) FROM assets WHERE path LIKE '%Screenshot%' "
            "OR path LIKE '%screenshot%' OR path LIKE '%截屏%' OR path LIKE '%屏幕%'"
        )
        # 还没跑识别的：有 assets 但没有当前描述。
        # 用 current_caption 而不是 merged_caption：真实库是 view（合成表），
        # 别的库可能没有这张表，直接查表会整条命令失败。
        unlabeled = one(
            "SELECT count(*) FROM assets a WHERE NOT EXISTS "
            "(SELECT 1 FROM current_caption m WHERE m.asset_id = a.id)"
        )
        # 重复可回收：keeper 之外的成员。去重还没跑过时这几张表可能不存在。
        try:
            dup_groups = one("SELECT count(*) FROM dup_groups")
            dup_reclaim = one(
                "SELECT count(*) FROM dup_groups g JOIN dup_members m ON m.group_id = g.id "
                "WHERE m.asset_id != g.keeper_id"
            )
            dup_bytes = one(
                "SELECT COALESCE(sum(a.size),0) FROM dup_groups g "
                "JOIN dup_members m ON m.group_id = g.id "
                "JOIN assets a ON a.id = m.asset_id WHERE m.asset_id != g.keeper_id"
            )
        except sqlite3.OperationalError:
            dup_groups, dup_reclaim, dup_bytes = 0, 0, 0
        days = one("SELECT count(DISTINCT day) FROM assets WHERE day IS NOT NULL")
        first_day, last_day = con.execute(
            "SELECT min(day), max(day) FROM assets WHERE day IS NOT NULL"
        ).fetchone() or (None, None)
    finally:
        con.close()

    return {
        "total": total,
        "images": images,
        "videos": videos,
        "bytes": bytes_total,
        "screenshots": screenshots,
        "unlabeled": unlabeled,
        "days": days,
        "first_day": first_day,
        "last_day": last_day,
        "dup": {
            "ready": dup_groups > 0,
            "groups": dup_groups,
            "count": dup_reclaim,
            "reclaim": dup_bytes,
        },
    }
