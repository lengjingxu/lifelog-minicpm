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


def delete_records(ids: list[str]) -> dict:
    """从库里移除记录：只删数据库行，不动磁盘文件。"""
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
