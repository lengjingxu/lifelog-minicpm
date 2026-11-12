#!/usr/bin/env python3
"""造一份 N 条的基准库，用来做 10 万级性能验证。

- 只读源库；不动 sample-data，不动真实库
- 图片不复制：thumb 用硬链接指向源库现有缩略图，photos 路径直接引用源库路径
- captions 从源库真实行抽样，tags/people/place 保持真实词表与基数

用法:
    python3 scripts/make_bench_db.py --source ~/dev/lifelog-minicpm/data/lifelog.sqlite --rows 100000 --out /tmp/sg-bench-10w
"""
from __future__ import annotations

import argparse
import json
import os
import random
import sqlite3
import time
from datetime import datetime, timedelta, timezone


def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True)
    ap.add_argument("--rows", type=int, default=100000)
    ap.add_argument("--out", required=True)
    ap.add_argument("--seed", type=int, default=20261112)
    return ap.parse_args()


def main():
    args = parse_args()
    random.seed(args.seed)
    t0 = time.time()

    os.makedirs(args.out, exist_ok=True)
    thumbs = os.path.join(args.out, "thumbs")
    os.makedirs(thumbs, exist_ok=True)
    photos = os.path.join(args.out, "photos")
    os.makedirs(photos, exist_ok=True)
    db_path = os.path.join(args.out, "lifelog.sqlite")
    for suffix in ("", "-wal", "-shm"):
        stale = db_path + suffix
        if os.path.exists(stale):
            os.remove(stale)

    source = os.path.expanduser(args.source)
    src_dir = os.path.dirname(source)
    src = sqlite3.connect("file:%s?mode=ro" % source, uri=True)
    schema = [
        r[1]
        for r in src.execute("select name, sql from sqlite_master where sql is not null and name not like 'sqlite_%'")
        if not (r[0].startswith("caption_fts_") and r[0] != "caption_fts")
    ]

    src_assets = src.execute(
        "select id, path, size, mtime, taken_at, day, lat, lon, kind from assets"
    ).fetchall()
    src_caps = src.execute(
        "select asset_id, model, model_version, prompt_version, caption, scene, people, place, activity, mood, tags, ocr_text, raw, status from captions"
    ).fetchall()
    if not src_assets or not src_caps:
        raise SystemExit("源库没有可用数据")

    dst = sqlite3.connect(db_path)
    dst.execute("pragma journal_mode=off")
    dst.execute("pragma synchronous=off")
    for sql in schema:
        try:
            dst.execute(sql)
        except Exception as exc:
            raise SystemExit("SCHEMA FAIL %r -> %s" % (sql[:160], exc))

    pool = sorted(f for f in os.listdir(os.path.join(src_dir, "thumbs")) if f.endswith(".jpg"))
    photo_pool = []
    for root, _dirs, files in os.walk(os.path.join(src_dir, "photos")):
        for f in files:
            if f.lower().endswith((".jpg", ".jpeg", ".png", ".heic", ".heif", ".mov", ".mp4")):
                photo_pool.append(os.path.join(root, f))
    photo_pool.sort()

    base = datetime(2011, 1, 1, 8, 0, tzinfo=timezone.utc)
    span = (datetime(2026, 11, 1, tzinfo=timezone.utc) - base).total_seconds()

    asset_rows = []
    cap_rows = []
    day_counts = {}
    cap_per = max(1, len(src_caps) // len(src_assets))
    n = args.rows

    for i in range(n):
        sa = src_assets[i % len(src_assets)]
        aid = "%016x" % (0xB100000000000000 + i)
        ts = base + timedelta(seconds=span * (i / max(1, n - 1)))
        taken = ts.strftime("%Y-%m-%dT%H:%M:%S+00:00")
        day = ts.strftime("%Y-%m-%d")
        kind = "video" if i % 11 == 0 else "image"
        src_photo = photo_pool[i % len(photo_pool)] if photo_pool else sa[1]
        photo_path = os.path.join(photos, "%06d%s" % (i, os.path.splitext(src_photo)[1].lower()))
        asset_rows.append((aid, photo_path, sa[2], sa[3], taken, day, sa[6], sa[7], kind, taken))
        day_counts[day] = day_counts.get(day, 0) + 1

        for k in range(cap_per if i % 3 else cap_per + 1):
            sc = src_caps[random.randrange(len(src_caps))]
            cap_rows.append((aid, sc[1], sc[2], sc[3], sc[4], sc[5], sc[6], sc[7], sc[8], sc[9], sc[10], sc[11], sc[12], sc[13], taken))

    dst.executemany("insert or replace into assets values (?,?,?,?,?,?,?,?,?,?)", asset_rows)

    seen = set()
    dedup = []
    for row in cap_rows:
        key = (row[0], row[1], row[3])
        if key in seen:
            continue
        seen.add(key)
        dedup.append(row)
    dst.executemany(
        "insert or replace into captions values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", dedup
    )

    day_rows = []
    for day, count in sorted(day_counts.items()):
        day_rows.append((day, count, count, json.dumps([]), None, None, None))
    dst.executemany("insert or replace into days values (?,?,?,?,?,?,?)", day_rows)

    src_events = src.execute("select title, summary, tags from events").fetchall()
    event_rows = []
    days_sorted = sorted(day_counts)
    step = max(1, len(days_sorted) // 2000)
    for idx, day in enumerate(days_sorted[::step]):
        e = src_events[idx % len(src_events)] if src_events else ("", "", "[]")
        event_rows.append((day, day, e[0], e[1], e[2], day_counts[day], "bench", day))
    dst.executemany(
        "insert into events (start_day, end_day, title, summary, tags, photo_count, model, created_at) values (?,?,?,?,?,?,?,?)",
        event_rows,
    )

    photo_links = 0
    for i in range(n):
        if not photo_pool:
            break
        src_photo = photo_pool[i % len(photo_pool)]
        dest = os.path.join(photos, "%06d%s" % (i, os.path.splitext(src_photo)[1].lower()))
        if os.path.exists(dest):
            continue
        try:
            os.link(src_photo, dest)
            photo_links += 1
        except OSError:
            break

    created = 0
    for i in range(n):
        aid = "%016x" % (0xB100000000000000 + i)
        name = pool[i % len(pool)] if pool else None
        if not name:
            break
        link = os.path.join(thumbs, aid + ".jpg")
        if os.path.exists(link):
            continue
        try:
            os.link(os.path.join(src_dir, "thumbs", name), link)
            created += 1
        except OSError:
            break

    dst.execute("create index if not exists idx_assets_taken on assets(taken_at)")
    dst.commit()
    dst.execute("pragma optimize")
    dst.close()
    src.close()

    size = os.path.getsize(db_path) / 1024 / 1024
    print(json.dumps({
        "out": args.out,
        "assets": n,
        "captions": len(dedup),
        "days": len(day_rows),
        "events": len(event_rows),
        "thumbs": created,
        "photos": photo_links,
        "db_mb": round(size, 1),
        "seconds": round(time.time() - t0, 1),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
