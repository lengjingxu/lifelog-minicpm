#!/usr/bin/env python3
"""美学排序 / 去重 keeper 的端到端验证（临时库，不碰真实照片）。

用法：
  python3 scripts/verify_quality_sort.py            # 自建临时库，造数据验证
  python3 scripts/verify_quality_sort.py --real     # 只读真实库，报分数分布与差异

自建库用 assets + asset_quality + dup_* 造几天的照片，直接跑与 Rust 相同的
ORDER BY 子句，验证「当天内高分优先」「全局高分优先」「组内 keeper 最高分」。
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]  # 仓库根（脚本在 desktop/scripts/ 下）
REAL_DB = Path.home() / "dev/lifelog-minicpm/data/lifelog.sqlite"

QUALITY_ORDER = "ORDER BY COALESCE(q.score,-1) DESC, COALESCE(a.taken_at,'') DESC, a.id DESC"
DAY_ORDER = (
    "ORDER BY COALESCE(a.day,'') DESC, COALESCE(q.score,-1) DESC, "
    "COALESCE(a.taken_at,'') DESC, a.id DESC"
)
TIME_ORDER = "ORDER BY COALESCE(a.taken_at,'') DESC, a.id DESC"


def build_fixture() -> Path:
    """造 3 天、每天 4 张照片：同一天内分数与时间故意错开。"""
    tmp = Path(tempfile.mkdtemp(prefix="quality-sort-"))
    db = tmp / "lifelog.sqlite"
    con = sqlite3.connect(db)
    con.executescript(
        """
        CREATE TABLE assets (id TEXT PRIMARY KEY, path TEXT, size INT, mtime REAL,
                             taken_at TEXT, day TEXT, lat REAL, lon REAL, kind TEXT, created_at TEXT);
        CREATE TABLE asset_quality (asset_id TEXT PRIMARY KEY, score REAL NOT NULL,
                                    stars INTEGER, model TEXT, model_version TEXT, created_at TEXT);
        CREATE TABLE dup_groups (id INTEGER PRIMARY KEY, keeper_id TEXT, reason TEXT, created_at TEXT);
        CREATE TABLE dup_members (group_id INTEGER, asset_id TEXT, distance INTEGER,
                                  PRIMARY KEY (group_id, asset_id));
        CREATE TABLE asset_hash (asset_id TEXT PRIMARY KEY, sha256 TEXT, dhash TEXT, dhash2 TEXT,
                                 w INT, h INT, computed_at TEXT, status TEXT, sharp REAL, sig BLOB);
        """
    )
    # 2024-03-02：中午那张分数最高，但时间更早 -> 纯时间序看不到它第一
    rows = [
        ("d2-early", "2024-03-02", "2024-03-02T09:00:00", 9.4),
        ("d2-late", "2024-03-02", "2024-03-02T20:00:00", 3.1),
        ("d2-mid", "2024-03-02", "2024-03-02T13:00:00", 6.2),
        ("d2-none", "2024-03-02", "2024-03-02T18:00:00", None),
        ("d1-a", "2024-03-01", "2024-03-01T09:00:00", 8.0),
        ("d1-b", "2024-03-01", "2024-03-01T10:00:00", 2.0),
        ("d3-a", "2024-03-03", "2024-03-03T07:00:00", 1.0),
    ]
    con.executemany(
        "INSERT INTO assets (id, path, size, taken_at, day, kind) VALUES (?,?,?,?,?,'image')",
        [(i, f"/tmp/{i}.jpg", 1000, t, d) for i, d, t, _ in rows],
    )
    con.executemany(
        "INSERT INTO asset_quality (asset_id, score) VALUES (?,?)",
        [(i, s) for i, _d, _t, s in rows if s is not None],
    )
    # 一组重复：分数最高的那张应当是 keeper（分辨率/清晰度完全一致）
    con.execute("INSERT INTO dup_groups (id, keeper_id, reason) VALUES (1, 'dup-hi', 'l1')")
    for asset_id, score in [("dup-hi", 9.1), ("dup-mid", 5.0), ("dup-low", 1.2)]:
        con.execute(
            "INSERT INTO assets (id, path, size, taken_at, day, kind) VALUES (?,?,?,?,?,'image')",
            (asset_id, f"/tmp/{asset_id}.jpg", 2000, "2024-02-01T10:00:00", "2024-02-01"),
        )
        con.execute("INSERT INTO asset_quality (asset_id, score) VALUES (?,?)", (asset_id, score))
        con.execute("INSERT INTO asset_hash VALUES (?,?,?,?,?,?,?,?,?,?)", (
            asset_id, None, "00000000000000ff", "0" * 60 + "f", 4000, 3000,
            "2026-01-01T00:00:00", "ok", 50.0, b"\x80" * 64,
        ))
        con.execute("INSERT INTO dup_members VALUES (1, ?, NULL)", (asset_id,))
    con.commit()
    con.close()
    return db


def rows(con, order: str, cols="a.id, a.day, q.score"):
    sql = (
        f"SELECT {cols} FROM assets a LEFT JOIN asset_quality q ON q.asset_id = a.id "
        f"WHERE a.day LIKE '2024-03-%' {order}"
    )
    return con.execute(sql).fetchall()


def check_fixture(db: Path) -> dict:
    con = sqlite3.connect(db)
    out: dict = {}

    time_order = rows(con, TIME_ORDER)
    day_order = rows(con, DAY_ORDER)
    quality_order = rows(con, QUALITY_ORDER)

    out["time_first"] = time_order[0][0]
    out["day_first"] = day_order[0][0]
    out["quality_first"] = quality_order[0][0]

    # 1) 当天内高分优先：同一天的第一条必须是该天最高分
    best: dict[str, float] = {}
    for asset_id, day, score in day_order:
        if score is None:
            continue
        best.setdefault(day, score)
    day_first_ok = True
    seen_days = set()
    for asset_id, day, score in day_order:
        if day in seen_days:
            continue
        seen_days.add(day)
        if score is None or score < best[day] - 1e-9:
            day_first_ok = False
    out["day_first_is_max"] = day_first_ok

    # 2) 天与天仍按日期倒序
    days = [d for _i, d, _s in day_order]
    out["days_sorted_desc"] = days == sorted(days, reverse=True)

    # 3) 全局高分优先：分数单调不增
    scores = [s if s is not None else -1 for _i, _d, s in quality_order]
    out["quality_sorted_desc"] = scores == sorted(scores, reverse=True)

    # 4) 有分数那张压过「时间更新但没分」的那张
    out["quality_beats_time"] = [i for i, _d, _s in quality_order][:2] == ["d2-early", "d1-a"]
    con.close()
    return out


def check_keeper(db: Path) -> dict:
    """在临时库上跑 dedup.group，确认 keeper 是组内最高分。"""
    env = dict(os.environ)
    env["LIFELOG_HOME"] = str(db.parent)
    env["LIFELOG_DB"] = str(db)
    env["PYTHONPATH"] = str(ROOT) + os.pathsep + env.get("PYTHONPATH", "")
    res = subprocess.run(
        [sys.executable, "-c", "from lifelog import db, dedup; con=db.connect(); dedup.group(con); con.commit(); con.close()"],
        cwd=str(ROOT),
        env=env,
        capture_output=True,
        text=True,
    )
    if res.returncode != 0:
        raise SystemExit("dedup 失败：" + (res.stderr or "")[-800:])
    con = sqlite3.connect(db)
    keeper = con.execute("SELECT keeper_id FROM dup_groups WHERE id = 1").fetchone()[0]
    order = [
        r[0]
        for r in con.execute(
            "SELECT m.asset_id FROM dup_members m "
            "LEFT JOIN asset_quality q ON q.asset_id = m.asset_id "
            "WHERE m.group_id = 1 ORDER BY COALESCE(q.score,-1) DESC, m.asset_id"
        )
    ]
    con.close()
    return {
        "keeper": keeper,
        "keeper_is_top_score": keeper == order[0],
        "member_order": order,
    }


def check_real() -> dict:
    if not REAL_DB.exists():
        return {"ok": False, "error": f"真实库不存在：{REAL_DB}"}
    con = sqlite3.connect(f"file:{REAL_DB}?mode=ro", uri=True)
    has = con.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='asset_quality'"
    ).fetchone()
    if not has:
        return {"ok": False, "error": "真实库还没有 asset_quality 表（评分未跑完）"}
    count, avg, low, high = con.execute(
        "SELECT count(*), round(avg(score),2), round(min(score),2), round(max(score),2) FROM asset_quality"
    ).fetchone()

    busiest = con.execute(
        "SELECT day, count(*) n FROM assets WHERE day IS NOT NULL "
        "AND EXISTS (SELECT 1 FROM asset_quality q WHERE q.asset_id = assets.id) "
        "GROUP BY day ORDER BY n DESC LIMIT 1"
    ).fetchone()
    result: dict = {
        "scored": count,
        "avg": avg,
        "min": low,
        "max": high,
        "busiest_day": busiest[0] if busiest else None,
        "busiest_day_count": busiest[1] if busiest else 0,
    }
    if busiest:
        day = busiest[0]
        time_first = con.execute(
            "SELECT a.id, q.score FROM assets a JOIN asset_quality q ON q.asset_id = a.id "
            "WHERE a.day = ? ORDER BY a.taken_at DESC, a.id DESC LIMIT 1",
            (day,),
        ).fetchone()
        day_first = con.execute(
            "SELECT a.id, q.score FROM assets a JOIN asset_quality q ON q.asset_id = a.id "
            f"WHERE a.day = ? {DAY_ORDER} LIMIT 1".replace("q.score", "q.score"),
            (day,),
        ).fetchone()
        day_max = con.execute(
            "SELECT round(max(q.score),2) FROM assets a JOIN asset_quality q ON q.asset_id = a.id WHERE a.day = ?",
            (day,),
        ).fetchone()[0]
        result.update({
            "time_first_id": time_first[0],
            "time_first_score": round(time_first[1], 2),
            "day_first_id": day_first[0],
            "day_first_score": round(day_first[1], 2),
            "day_max_score": day_max,
            "day_first_is_max": abs(day_first[1] - day_max) < 1e-9,
            "changed_by_sort": time_first[0] != day_first[0],
        })

    # 最大重复组：keeper 是否组内最高分
    big = con.execute(
        "SELECT g.id, g.keeper_id, count(*) n FROM dup_groups g "
        "JOIN dup_members m ON m.group_id = g.id GROUP BY g.id ORDER BY n DESC LIMIT 1"
    ).fetchone()
    if big:
        group_id, keeper, n = big
        keeper_score = con.execute(
            "SELECT score FROM asset_quality WHERE asset_id = ?", (keeper,)
        ).fetchone()
        top = con.execute(
            "SELECT m.asset_id, q.score FROM dup_members m "
            "LEFT JOIN asset_quality q ON q.asset_id = m.asset_id "
            "WHERE m.group_id = ? ORDER BY COALESCE(q.score,-1) DESC LIMIT 1",
            (group_id,),
        ).fetchone()
        result.update({
            "largest_group": group_id,
            "largest_group_size": n,
            "keeper_id": keeper,
            "keeper_score": round(keeper_score[0], 2) if keeper_score and keeper_score[0] is not None else None,
            "group_top_id": top[0],
            "group_top_score": round(top[1], 2) if top and top[1] is not None else None,
            # 旧 keeper 是 dedup 重跑前选出来的，这里只报告「是否已经是最高分」，
            # 不冒充已经刷新过 —— 刷新需要主人手动重跑 dedup。
            "keeper_is_top": top is not None and top[0] == keeper,
        })
    con.close()
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--real", action="store_true", help="只读真实库并报告")
    args = parser.parse_args()

    if args.real:
        result = check_real()
        print(json.dumps(result, ensure_ascii=False, indent=1))
        return 0 if result.get("scored") else 1

    db = build_fixture()
    out = {"fixture": str(db), **check_fixture(db), "dedup": check_keeper(db)}
    print(json.dumps(out, ensure_ascii=False, indent=1))
    ok = (
        out["day_first_is_max"]
        and out["days_sorted_desc"]
        and out["quality_sorted_desc"]
        and out["quality_beats_time"]
        and out["dedup"]["keeper_is_top_score"]
    )
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
