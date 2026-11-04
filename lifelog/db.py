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
CREATE INDEX IF NOT EXISTS idx_captions_asset ON captions(asset_id);
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
