#!/usr/bin/env python3
"""在基准库上跑客户端真实查询形状，给出 10 万级的时间分布。

用法:
    python3 scripts/bench_100k.py --db /tmp/sg-bench-10w/lifelog.sqlite
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import statistics
import time

BASE = (
    " FROM assets a LEFT JOIN captions c ON c.rowid = ("
    " SELECT rowid FROM captions c2 WHERE c2.asset_id = a.id ORDER BY c2.created_at DESC LIMIT 1)"
)
SELECT = (
    "SELECT a.id, a.path, a.day, a.taken_at, a.kind, c.caption, c.scene, c.people,"
    " c.place, c.activity, c.mood, c.tags, c.ocr_text" + BASE
)


def timed(conn, sql, params=(), repeats=3, warmup=True):
    times = []
    rows = 0
    if warmup:
        # 先跑一次把页缓存预热，否则第一条查询会把冷读算进来，数字不可比
        conn.execute(sql, params).fetchall()
    for _ in range(repeats):
        t0 = time.perf_counter()
        cur = conn.execute(sql, params)
        got = cur.fetchall()
        times.append((time.perf_counter() - t0) * 1000)
        rows = len(got)
    return {"ms_median": round(statistics.median(times), 1), "ms_max": round(max(times), 1), "rows": rows}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    args = ap.parse_args()

    conn = sqlite3.connect("file:%s?mode=ro" % os.path.expanduser(args.db), uri=True)
    # 需要先跑过 lifelog init（生成列 + 索引）；这里直接检查，缺了就提醒
    cols = {r[1] for r in conn.execute("pragma table_xinfo(assets)")}
    if "taken_sort" not in cols:
        raise SystemExit("基准库缺少 taken_sort，请先对该库跑一次 lifelog init")
    conn.execute("pragma cache_size=-64000")
    out = {}

    n = conn.execute("select count(*) from assets").fetchone()[0]
    out["assets"] = n

    out["first_page_500"] = timed(conn, SELECT + " ORDER BY a.taken_sort DESC, a.id DESC LIMIT ? OFFSET ?", (500, 0))
    out["deep_offset_50k"] = timed(conn, SELECT + " ORDER BY a.taken_sort DESC, a.id DESC LIMIT ? OFFSET ?", (500, 50000), repeats=1)
    out["deep_offset_95k"] = timed(conn, SELECT + " ORDER BY a.taken_sort DESC, a.id DESC LIMIT ? OFFSET ?", (500, 95000), repeats=1)

    # keyset 对照：与 query_assets 的 cursor 分支同一形状
    order = " ORDER BY a.taken_sort DESC, a.id DESC LIMIT 500"
    for label, skip in (("keyset_50k", 50000), ("keyset_95k", 95000)):
        row = conn.execute(
            "select taken_sort, id from assets order by taken_sort desc, id desc limit 1 offset ?",
            (skip,),
        ).fetchone()
        if row:
            out[label] = timed(
                conn,
                SELECT + " WHERE (a.taken_sort, a.id) < (?, ?)" + order,
                row,
                repeats=2,
            )

    q = "%公园%"
    out["search_like"] = timed(
        conn,
        SELECT
        + " WHERE (c.caption LIKE ?1 OR c.tags LIKE ?1 OR c.scene LIKE ?1 OR c.ocr_text LIKE ?1 OR c.place LIKE ?1 OR a.path LIKE ?1)"
        + " ORDER BY a.taken_sort DESC, a.id DESC LIMIT 500 OFFSET 0",
        (q,),
    )
    out["count_search_like"] = timed(
        conn,
        "SELECT count(*)" + BASE
        + " WHERE (c.caption LIKE ?1 OR c.tags LIKE ?1 OR c.scene LIKE ?1 OR c.ocr_text LIKE ?1 OR c.place LIKE ?1 OR a.path LIKE ?1)",
        (q,),
    )

    out["tag_exact"] = timed(
        conn,
        SELECT + " WHERE 1=1 AND ((json_valid(c.tags) AND EXISTS (SELECT 1 FROM json_each(c.tags) WHERE json_each.value = ?1)))"
        + " ORDER BY a.taken_sort DESC, a.id DESC LIMIT 500 OFFSET 0",
        ("旅行",),
    )
    out["person_like"] = timed(
        conn,
        SELECT + " WHERE 1=1 AND c.people LIKE '%' || ?1 || '%' ORDER BY a.taken_sort DESC, a.id DESC LIMIT 500 OFFSET 0",
        ("一人",),
    )
    out["scene_eq"] = timed(
        conn,
        SELECT + " WHERE 1=1 AND c.scene = ?1 ORDER BY a.taken_sort DESC, a.id DESC LIMIT 500 OFFSET 0",
        ("户外",),
    )

    out["facets_scan"] = timed(
        conn,
        "SELECT c.tags, c.scene, c.people" + BASE,
        repeats=2,
    )
    out["timeline_months"] = timed(
        conn,
        "SELECT substr(day,1,7) AS m, count(*) FROM assets WHERE day IS NOT NULL GROUP BY m ORDER BY m DESC",
        repeats=2,
    )

    print(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
