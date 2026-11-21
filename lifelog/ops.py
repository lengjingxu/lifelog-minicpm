"""用户侧的书目操作：批量标签与相册（与 AI 描述分开存，互不覆盖）。"""
from __future__ import annotations

import json
import sqlite3
import time
import uuid
from pathlib import Path

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS asset_tags (
    asset_id TEXT NOT NULL,
    tag TEXT NOT NULL,
    created_at TEXT,
    PRIMARY KEY (asset_id, tag)
);
CREATE TABLE IF NOT EXISTS albums (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    created_at TEXT
);
CREATE TABLE IF NOT EXISTS album_assets (
    album_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    added_at TEXT,
    PRIMARY KEY (album_id, asset_id)
);
CREATE INDEX IF NOT EXISTS idx_asset_tags_tag ON asset_tags(tag);
CREATE INDEX IF NOT EXISTS idx_album_assets_asset ON album_assets(asset_id);
"""


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S")


def connect(db_path: Path | None = None) -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path or config.DB_PATH))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript(SCHEMA)
    return conn


def add_tag(ids: list[str], tag: str) -> dict:
    tag = tag.strip()
    if not tag:
        raise SystemExit("标签不能为空")
    conn = connect()
    now = _now()
    changed = 0
    for asset_id in ids:
        cur = conn.execute(
            "INSERT OR IGNORE INTO asset_tags (asset_id, tag, created_at) VALUES (?, ?, ?)",
            (asset_id, tag, now),
        )
        changed += cur.rowcount
    conn.commit()
    conn.close()
    return {"ok": True, "tag": tag, "added": changed, "requested": len(ids)}


def remove_tag(ids: list[str], tag: str) -> dict:
    conn = connect()
    changed = 0
    for asset_id in ids:
        cur = conn.execute(
            "DELETE FROM asset_tags WHERE asset_id = ? AND tag = ?", (asset_id, tag)
        )
        changed += cur.rowcount
    conn.commit()
    conn.close()
    return {"ok": True, "tag": tag, "removed": changed, "requested": len(ids)}


def create_album(name: str) -> dict:
    name = name.strip()
    if not name:
        raise SystemExit("相册名不能为空")
    conn = connect()
    row = conn.execute("SELECT id FROM albums WHERE name = ?", (name,)).fetchone()
    if row:
        conn.close()
        return {"ok": True, "album": {"id": row[0], "name": name}, "created": False}
    album_id = uuid.uuid4().hex[:12]
    conn.execute(
        "INSERT INTO albums (id, name, created_at) VALUES (?, ?, ?)", (album_id, name, _now())
    )
    conn.commit()
    conn.close()
    return {"ok": True, "album": {"id": album_id, "name": name}, "created": True}


def _album_id(conn: sqlite3.Connection, name: str) -> str:
    row = conn.execute("SELECT id FROM albums WHERE name = ?", (name,)).fetchone()
    if not row:
        raise SystemExit(f"相册不存在：{name}")
    return row[0]


def add_to_album(name: str, ids: list[str]) -> dict:
    conn = connect()
    row = conn.execute("SELECT id FROM albums WHERE name = ?", (name,)).fetchone()
    if not row:
        # 输入新名字时直接建：界面上「加入相册」只有一个输入框
        album_id = uuid.uuid4().hex[:12]
        conn.execute(
            "INSERT INTO albums (id, name, created_at) VALUES (?, ?, ?)",
            (album_id, name, _now()),
        )
        conn.commit()
        row = (album_id,)
    album_id = row[0]
    now = _now()
    changed = 0
    for asset_id in ids:
        cur = conn.execute(
            "INSERT OR IGNORE INTO album_assets (album_id, asset_id, added_at) VALUES (?, ?, ?)",
            (album_id, asset_id, now),
        )
        changed += cur.rowcount
    conn.commit()
    conn.close()
    return {"ok": True, "album": name, "added": changed, "requested": len(ids)}


def remove_from_album(name: str, ids: list[str]) -> dict:
    conn = connect()
    album_id = _album_id(conn, name)
    changed = 0
    for asset_id in ids:
        cur = conn.execute(
            "DELETE FROM album_assets WHERE album_id = ? AND asset_id = ?", (album_id, asset_id)
        )
        changed += cur.rowcount
    conn.commit()
    conn.close()
    return {"ok": True, "album": name, "removed": changed, "requested": len(ids)}


def list_albums() -> dict:
    conn = connect()
    rows = conn.execute(
        """SELECT a.id, a.name, count(x.asset_id)
           FROM albums a LEFT JOIN album_assets x ON x.album_id = a.id
           GROUP BY a.id ORDER BY a.created_at DESC"""
    ).fetchall()
    conn.close()
    return {"ok": True, "albums": [{"id": r[0], "name": r[1], "count": r[2]} for r in rows]}


def drop_from_cleanup_queue(ids: list[str]) -> int:
    """真实清理后同步移除待清理清单行。清单表不存在时什么也不做。"""
    from . import space

    return space.drop_ids(ids)


def delete_records(ids: list[str]) -> dict:
    """从库里移除记录：只删数据库行，不动磁盘文件。

    删文件由桌面端负责（原图移到废纸篓），CLI 这边不碰磁盘。
    """
    ids = [i for i in ids if i]
    if not ids:
        raise SystemExit("没有要删除的记录")
    conn = connect()
    removed = {"captions": 0, "asset_tags": 0, "album_assets": 0, "assets": 0}
    try:
        conn.execute("BEGIN")
        for table in ("captions", "asset_tags", "album_assets", "assets"):
            marks = ",".join("?" for _ in ids)
            cur = conn.execute(
                f"DELETE FROM {table} WHERE "
                + ("asset_id IN (" + marks + ")" if table != "assets" else "id IN (" + marks + ")"),
                ids,
            )
            removed[table] = cur.rowcount
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    return {"ok": True, "requested": len(ids), "removed": removed}


# ---------- 最近删除（软删除） ----------

RETENTION_DAYS = 30


def _clean_ids(ids: list[str]) -> list[str]:
    return list(dict.fromkeys(i.strip() for i in ids if i and i.strip()))


def record_trash(ids: list[str]) -> dict:
    """软删除：只写 deleted_at，不动文件、不删关联行（还原零成本）。"""
    ids = _clean_ids(ids)
    if not ids:
        raise SystemExit("没有要删除的照片")
    conn = connect()
    try:
        marks = ",".join("?" for _ in ids)
        cur = conn.execute(
            f"UPDATE assets SET deleted_at = ? WHERE id IN ({marks}) AND deleted_at IS NULL",
            [_now(), *ids],
        )
        # 已经在回收站里的照片不该继续留在待清理清单里（清单表可能还不存在）。
        try:
            conn.execute(f"DELETE FROM cleanup_queue WHERE asset_id IN ({marks})", ids)
        except sqlite3.OperationalError:
            pass
        conn.commit()
        changed = cur.rowcount
    finally:
        conn.close()
    return {"ok": True, "requested": len(ids), "trashed": changed}


def record_restore(ids: list[str]) -> dict:
    """还原：把 deleted_at 清空，照片回到原来的位置。"""
    ids = _clean_ids(ids)
    if not ids:
        raise SystemExit("没有要还原的照片")
    conn = connect()
    try:
        marks = ",".join("?" for _ in ids)
        cur = conn.execute(
            f"UPDATE assets SET deleted_at = NULL WHERE id IN ({marks}) AND deleted_at IS NOT NULL",
            ids,
        )
        conn.commit()
        changed = cur.rowcount
    finally:
        conn.close()
    return {"ok": True, "requested": len(ids), "restored": changed}


def trash_list(limit: int | None = None, offset: int = 0) -> dict:
    """回收站列表：只读，按删除时间倒序。"""
    conn = connect()
    try:
        total, total_bytes = conn.execute(
            "SELECT count(*), COALESCE(sum(size),0) FROM assets WHERE deleted_at IS NOT NULL"
        ).fetchone()
        sql = (
            "SELECT a.id, a.path, a.day, a.taken_at, a.kind, a.size, a.deleted_at "
            "FROM assets a WHERE a.deleted_at IS NOT NULL "
            "ORDER BY a.deleted_at DESC, a.id DESC"
        )
        params: list = []
        if limit:
            sql += " LIMIT ? OFFSET ?"
            params = [int(limit), max(0, int(offset))]
        rows = conn.execute(sql, params).fetchall()
    finally:
        conn.close()
    thumbs_dir = config.DATA_DIR / "thumbs"
    items = [
        {
            "id": row[0],
            "path": row[1],
            "day": row[2],
            "taken_at": row[3],
            "kind": row[4],
            "size": row[5],
            "deleted_at": row[6],
            # 回收站优先显示缩略图：原图可能在外置盘，直接读原图会很慢。
            "thumb": str(thumbs_dir / f"{row[0]}.jpg")
            if (thumbs_dir / f"{row[0]}.jpg").exists()
            else "",
        }
        for row in rows
    ]
    return {
        "count": total or 0,
        "bytes": total_bytes or 0,
        "items": items,
        "retention_days": RETENTION_DAYS,
    }


def expired_ids(days: int = RETENTION_DAYS, now: str | None = None) -> list[str]:
    """超过保留期的 id（启动时自动清理用）。"""
    now = now or _now()
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT id FROM assets WHERE deleted_at IS NOT NULL "
            "AND julianday(?) - julianday(deleted_at) > ? ORDER BY deleted_at",
            (now, days),
        ).fetchall()
    finally:
        conn.close()
    return [row[0] for row in rows]


def trash_purge(ids: list[str]) -> dict:
    """真删记录（文件由桌面端先移进系统废纸篓）。"""
    return delete_records(ids)

def prune_orphan_thumbs(ids: list[str] | None = None, dry_run: bool = False) -> dict:
    """清理孤儿缩略图。

    ids 给了就只处理这些 id 的缩略图；不给就扫描 thumbs 目录，
    删掉库里已经没有对应 asset 的文件。只动缩略图缓存，不动原图。
    """
    thumbs_dir = config.DATA_DIR / "thumbs"
    full_dir = thumbs_dir / "full"
    removed: list[str] = []
    freed = 0

    if ids:
        for asset_id in ids:
            for path in (thumbs_dir / f"{asset_id}.jpg", full_dir / f"{asset_id}.jpg"):
                if path.exists():
                    freed += path.stat().st_size
                    if not dry_run:
                        path.unlink(missing_ok=True)
                    removed.append(path.name)
        # 记录已经删了，这些 id 不该继续留在坏件名单里。
        broken_path = thumbs_dir / "broken.json"
        if broken_path.exists():
            try:
                broken = json.loads(broken_path.read_text(encoding="utf-8"))
            except Exception:
                broken = {}
            stale = [i for i in ids if i in broken]
            if stale and not dry_run:
                for asset_id in stale:
                    broken.pop(asset_id, None)
                broken_path.write_text(json.dumps(broken, ensure_ascii=False, indent=2), encoding="utf-8")
            removed.extend(f"broken.json:{i}" for i in stale)
        return {"ok": True, "removed": len(removed), "freed_bytes": freed, "dry_run": dry_run}

    if not thumbs_dir.is_dir():
        return {"ok": True, "removed": 0, "freed_bytes": 0, "dry_run": dry_run}

    conn = connect()
    known = {row[0] for row in conn.execute("SELECT id FROM assets")}
    conn.close()
    for path in list(thumbs_dir.glob("*.jpg")) + list(full_dir.glob("*.jpg")):
        if path.stem in known:
            continue
        freed += path.stat().st_size
        removed.append(path.name)
        if not dry_run:
            path.unlink(missing_ok=True)
    return {"ok": True, "removed": len(removed), "freed_bytes": freed, "dry_run": dry_run}
