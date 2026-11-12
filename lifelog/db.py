"""SQLite 存储层：资产、描述、事件、生活画像。"""
from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager

from . import config

SCHEMA = """
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY,
    path TEXT UNIQUE NOT NULL,
    size INTEGER,
    mtime REAL,
    taken_at TEXT,
    day TEXT,
    lat REAL,
    lon REAL,
    kind TEXT DEFAULT 'image',
    created_at TEXT
);

CREATE TABLE IF NOT EXISTS captions (
    asset_id TEXT NOT NULL,
    model TEXT NOT NULL,
    model_version TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    caption TEXT,
    scene TEXT,
    people TEXT,
    place TEXT,
    activity TEXT,
    mood TEXT,
    tags TEXT,
    ocr_text TEXT,
    raw TEXT,
    status TEXT DEFAULT 'ok',
    created_at TEXT,
    PRIMARY KEY (asset_id, model, prompt_version)
);

CREATE TABLE IF NOT EXISTS days (
    day TEXT PRIMARY KEY,
    photo_count INTEGER DEFAULT 0,
    described INTEGER DEFAULT 0,
    tags TEXT,
    summary TEXT,
    hour_histogram TEXT,
    updated_at TEXT
);

CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    start_day TEXT NOT NULL,
    end_day TEXT NOT NULL,
    title TEXT,
    summary TEXT,
    tags TEXT,
    photo_count INTEGER DEFAULT 0,
    model TEXT,
    created_at TEXT
);

CREATE TABLE IF NOT EXISTS profile (
    key TEXT PRIMARY KEY,
    value TEXT,
    evidence INTEGER DEFAULT 0,
    updated_at TEXT
);

CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stage TEXT,
    model TEXT,
    started_at TEXT,
    finished_at TEXT,
    stats TEXT
);

CREATE INDEX IF NOT EXISTS idx_assets_day ON assets(day);
-- 列表按 (taken_at, day, id) 倒序翻页：没有这条索引，10 万级首屏要扫全表（实测 74.8ms -> 0.7ms）。
CREATE INDEX IF NOT EXISTS idx_assets_taken ON assets(taken_at DESC, day DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_captions_asset ON captions(asset_id);
"""

# 每个 asset 只取一条描述：优先当前主模型，其次最新的 ok 记录。
# 用视图而不是散落各处的 WHERE，避免统计口径漂移（曾经把旧模型的条目也算了进去）。
CURRENT_CAPTION_VIEW = """
CREATE VIEW IF NOT EXISTS current_caption AS
SELECT c.* FROM captions c
JOIN (
    SELECT asset_id, MAX(
        CASE WHEN model = 'minicpm-v-4.7-1b' AND status = 'ok' THEN 2
             WHEN status = 'ok' THEN 1
             ELSE 0 END
    ) AS rank
    FROM captions GROUP BY asset_id
) best ON best.asset_id = c.asset_id
WHERE c.status = 'ok' AND (
    (best.rank = 2 AND c.model = 'minicpm-v-4.7-1b') OR (best.rank = 1 AND c.status = 'ok')
)
GROUP BY c.asset_id;
"""

FTS_SCHEMA = """
CREATE VIRTUAL TABLE IF NOT EXISTS caption_fts USING fts5(
    asset_id UNINDEXED, caption, tags, place, activity, ocr_text,
    tokenize='unicode61'
);
"""


def connect() -> sqlite3.Connection:
    config.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(config.DB_PATH, timeout=60)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA busy_timeout=60000")
    return con


def init_db() -> None:
    with connect() as con:
        con.executescript(SCHEMA)
        try:
            con.executescript(FTS_SCHEMA)
        except sqlite3.OperationalError:
            pass
        try:
            con.executescript(CURRENT_CAPTION_VIEW)
        except sqlite3.OperationalError:
            pass


@contextmanager
def session():
    con = connect()
    try:
        yield con
        con.commit()
    finally:
        con.close()


def jdump(value) -> str:
    return json.dumps(value, ensure_ascii=False)


def jload(value, default=None):
    if not value:
        return [] if default is None else default
    try:
        return json.loads(value)
    except (ValueError, TypeError):
        return [] if default is None else default
