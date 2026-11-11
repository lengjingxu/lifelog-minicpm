#!/usr/bin/env python3
"""Export the sample library to a browser-preview fixture.

The fixture has the same shape as the Tauri adapter's return values. Image URLs
point at relative thumbs/photos paths, which the API adapter maps to /__fixture in
the browser and to the Tauri asset protocol in the desktop app;
the production macOS app always uses the asset protocol through the Tauri path.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
from collections import Counter
from pathlib import Path

DEFAULT_HOME = Path(__file__).resolve().parent.parent / "sample-data"
DEFAULT_OUT = Path(__file__).resolve().parent.parent / "public" / "sample-fixture.json"



def _display_path(target: Path, home: Path) -> str:
    try:
        return target.resolve().relative_to(home.resolve()).as_posix()
    except (ValueError, OSError):
        return target.name


def parse_tags(raw: str | None) -> list[str]:
    if not raw:
        return []
    try:
        value = json.loads(raw)
        return [str(tag) for tag in value] if isinstance(value, list) else []
    except json.JSONDecodeError:
        return []


def clean(value: str | None) -> str | None:
    if value is None:
        return None
    value = value.strip()
    return value or None


def split_people(value: str | None) -> list[str]:
    if not value:
        return []
    for separator in ("、", "，", ",", "/", ";", "；"):
        value = value.replace(separator, "|")
    return [part.strip() for part in value.split("|") if part.strip()]


def main() -> None:
    parser = argparse.ArgumentParser(description="导出浏览器示例 fixture")
    parser.add_argument("--home", type=Path, default=DEFAULT_HOME)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    home = args.home.expanduser().resolve()
    db_path = Path(os.environ.get("LIFELOG_DB", home / "lifelog.sqlite"))
    if not db_path.exists():
        raise SystemExit(f"找不到数据库: {db_path}")

    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        """SELECT a.id, a.path, a.day, a.taken_at, a.kind,
                  c.caption, c.scene, c.people, c.place, c.activity, c.mood,
                  c.tags, c.ocr_text
           FROM assets a
           LEFT JOIN captions c ON c.rowid = (
             SELECT rowid FROM captions c2
             WHERE c2.asset_id = a.id ORDER BY c2.created_at DESC LIMIT 1)
           ORDER BY a.taken_at DESC, a.day DESC"""
    ).fetchall()
    tags_count: Counter[str] = Counter()
    scenes_count: Counter[str] = Counter()
    people_count: Counter[str] = Counter()
    months_count: Counter[str] = Counter()
    assets = []
    for row in rows:
        asset_id = row["id"]
        tags = parse_tags(row["tags"])
        tags_count.update(tags)
        if clean(row["scene"]):
            scenes_count[clean(row["scene"])] += 1
        for person in split_people(row["people"]):
            if person not in {"无", "未知"}:
                people_count[person] += 1
        if clean(row["day"]):
            months_count[clean(row["day"])[:7]] += 1
        thumb = home / "thumbs" / f"{asset_id}.jpg"
        full = home / "thumbs" / "full" / f"{asset_id}.jpg"
        if full.exists():
            original_url = f"thumbs/full/{asset_id}.jpg"
        else:
            # 浏览器模式只能读 home 下的相对路径；原图在 home 外就退回缩略图，
            # 否则会拼出 /__fixture/<绝对路径> 变成破图。
            raw = Path(row["path"])
            if not raw.is_absolute():
                original_url = raw.as_posix()
            else:
                try:
                    original_url = raw.resolve().relative_to(home.resolve()).as_posix()
                except (ValueError, OSError):
                    original_url = f"thumbs/{asset_id}.jpg" if thumb.exists() else ""
        asset = {
            "id": asset_id,
            "path": row["path"],
            "thumb": f"thumbs/{asset_id}.jpg" if thumb.exists() else original_url,
            "original": original_url,
            "day": row["day"],
            "taken_at": row["taken_at"],
            "kind": row["kind"],
            "caption": row["caption"],
            "scene": row["scene"],
            "people": row["people"],
            "place": row["place"],
            "activity": row["activity"],
            "mood": row["mood"],
            "tags": tags,
            "ocr_text": row["ocr_text"],
        }
        assets.append(asset)

    def pairs(counter: Counter[str]) -> list[list[object]]:
        return [[name, count] for name, count in sorted(counter.items(), key=lambda item: (-item[1], item[0]))]

    first_day = min((row["day"] for row in rows if row["day"]), default=None)
    last_day = max((row["day"] for row in rows if row["day"]), default=None)
    stats = {
        "assets": len(rows),
        "captions": conn.execute("SELECT count(*) FROM captions").fetchone()[0],
        "days": conn.execute("SELECT count(*) FROM days").fetchone()[0],
        "events": conn.execute("SELECT count(*) FROM events").fetchone()[0],
        "first_day": first_day,
        "last_day": last_day,
        # 不写导出机器的绝对路径：优先相对 home，其次只留文件名。
        "db_path": _display_path(db_path, home),
        "db_size": db_path.stat().st_size,
    }
    facets = {
        "tags": pairs(tags_count),
        "scenes": pairs(scenes_count),
        "people": pairs(people_count),
        "months": [[month, count] for month, count in sorted(months_count.items(), reverse=True)],
    }
    conn.close()

    payload = {"stats": stats, "assets": assets, "facets": facets}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {args.out} · {len(assets)} assets · {args.out.stat().st_size} bytes")


if __name__ == "__main__":
    main()
