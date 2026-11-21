#!/usr/bin/env python3
"""阶段一验收：软删 / 还原 / 清空回收站 / 30 天自动清理（真实库 + 临时测试文件）。

安全边界：
- 只操作本脚本自己造的 asset（id 前缀 sgs-），以及 /Volumes/Leng/_sgcheck 下的测试文件。
- 结束时删除这些记录、把文件从废纸篓搬回并删掉，并核对库总数与开始时一致。

用法：~/dev/lifelog-minicpm/.venv/bin/python desktop/scripts/verify_trash_flow.py
"""
from __future__ import annotations

import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

HOME = Path.home()
DATA = HOME / "dev/lifelog-minicpm/data"
DB = DATA / "lifelog.sqlite"
VENV = HOME / "dev/lifelog-minicpm/.venv/bin/python"
ROOT = Path(__file__).resolve().parents[2]
TEST_DIR = Path("/Volumes/Leng/_sgcheck")
TRASH = Path("/Volumes/Leng/.Trashes/501")
PREFIX = "sgs-trash-"


def py(*args: str) -> dict:
    """在真实库上跑 lifelog CLI（LIFELOG_HOME 指向真实库）。"""
    env = dict(os.environ)
    env["LIFELOG_HOME"] = str(DATA)
    env["PYTHONPATH"] = str(ROOT)
    out = subprocess.run(
        [str(VENV), "-m", "lifelog.cli", *args],
        cwd=str(ROOT), env=env, capture_output=True, text=True,
    )
    text = out.stdout.strip().splitlines()[-1] if out.stdout.strip() else "{}"
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {"stdout": out.stdout, "stderr": out.stderr, "code": out.returncode}


def q(sql: str, params=()):
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    try:
        return con.execute(sql, params).fetchall()
    finally:
        con.close()


def exec_sql(sql: str, params=()):
    con = sqlite3.connect(DB)
    try:
        cur = con.execute(sql, params)
        con.commit()
        return cur.rowcount
    finally:
        con.close()


def make_file(name: str, size: int = 2_000_000) -> Path:
    TEST_DIR.mkdir(parents=True, exist_ok=True)
    path = TEST_DIR / name
    path.write_bytes(b"\x00" * size)
    return path


def insert_asset(asset_id: str, path: Path) -> None:
    exec_sql(
        "INSERT OR REPLACE INTO assets (id, path, size, mtime, taken_at, day, kind, created_at) "
        "VALUES (?,?,?,?,?,?,?,datetime('now','localtime'))",
        (asset_id, str(path), path.stat().st_size, time.time(), "2026-11-19T12:00:00", "2026-11-19", "image"),
    )


def cleanup(ids: list[str], files: list[Path]) -> None:
    for asset_id in ids:
        exec_sql("DELETE FROM assets WHERE id=?", (asset_id,))
        exec_sql("DELETE FROM asset_quality WHERE asset_id=?", (asset_id,))
        exec_sql("DELETE FROM cleanup_queue WHERE asset_id=?", (asset_id,))
    for path in files:
        if path.exists():
            path.unlink()
        trashed = TRASH / path.name
        if trashed.exists():
            target = TEST_DIR / path.name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(trashed), str(target))
            target.unlink()
        # 系统可能加了「 2」后缀
        for extra in TRASH.glob(path.stem + "*"):
            try:
                extra.unlink()
            except OSError:
                pass


def main() -> int:
    if not DB.exists():
        raise SystemExit(f"真实库不存在：{DB}")
    # 老库还没跑过新版 CLI 的话 deleted_at 列不存在；先做一次幂等迁移（只加列）。
    migrate = subprocess.run(
        [str(VENV), "-c", "from lifelog import db; db.init_db()"],
        cwd=str(ROOT), env={**os.environ, "LIFELOG_HOME": str(DATA), "PYTHONPATH": str(ROOT)},
        capture_output=True, text=True,
    )
    if migrate.returncode != 0:
        raise SystemExit("初始化 schema 失败：" + migrate.stderr[-500:])
    result: dict = {}
    ids = [f"{PREFIX}soft", f"{PREFIX}purge", f"{PREFIX}expired"]
    files = [
        make_file("sgs-soft.jpg"),
        make_file("sgs-purge.jpg"),
        make_file("sgs-expired.jpg"),
    ]
    baseline = q("SELECT count(*) FROM assets")[0][0]
    deleted_baseline = q("SELECT count(*) FROM assets WHERE deleted_at IS NOT NULL")[0][0]
    visible_baseline = baseline - deleted_baseline
    try:
        for asset_id, path in zip(ids, files):
            insert_asset(asset_id, path)

        # 1. 软删
        soft = py("record-trash", "--ids", ids[0])
        row = q("SELECT deleted_at FROM assets WHERE id=?", (ids[0],))[0][0]
        total_after = q("SELECT count(*) FROM assets")[0][0]
        visible_after = q("SELECT count(*) FROM assets WHERE deleted_at IS NULL")[0][0]
        result["soft_delete"] = {
            "cli": soft,
            "assets_total_baseline": baseline,
            "assets_total_after": total_after,
            "deleted_at_set": bool(row),
            "file_still_there": files[0].exists(),
            "visible_baseline": visible_baseline,
            "visible_after": visible_after,
            "listed_in_trash": q("SELECT count(*) FROM assets WHERE id=? AND deleted_at IS NOT NULL", (ids[0],))[0][0],
        }

        # 2. 图库清理统计也少一张
        space = py("space-summary")
        result["space_summary"] = {
            "assets": space.get("assets"),
            "photos": space.get("photos", {}).get("count"),
            "expected_assets": visible_after,
        }

        # 3. 还原
        restored = py("record-restore", "--ids", ids[0])
        result["restore"] = {
            "cli": restored,
            "deleted_at": q("SELECT deleted_at FROM assets WHERE id=?", (ids[0],))[0][0],
            "visible_after": q("SELECT count(*) FROM assets WHERE deleted_at IS NULL")[0][0],
            "visible_baseline": visible_baseline,
        }

        # 4. 清空回收站（单张）：文件进废纸篓、记录消失
        py("record-trash", "--ids", ids[1])
        before = files[1].exists()
        trashed_before = len(list(TRASH.glob("sgs-purge*")))
        out = py("trash-empty", "--ids", ids[1])
        time.sleep(1.0)
        # CLI 只删记录；文件移进废纸篓是桌面端 empty_trash（Rust）做的，
        # 这里按与桌面端相同的顺序手动移一次，验证两步组合是通的。
        moved = False
        if files[1].exists():
            moved = subprocess.run(
                ["osascript", "-e", f'tell application "Finder" to delete POSIX file "{files[1]}"'],
                capture_output=True, text=True,
            ).returncode == 0
        time.sleep(0.5)
        result["purge"] = {
            "cli": out,
            "file_existed_before": before,
            "finder_moved": moved or not files[1].exists(),
            "file_gone": not files[1].exists(),
            "in_system_trash": [p.name for p in TRASH.glob("sgs-purge*")],
            "trashed_before": trashed_before,
            "row_left": q("SELECT count(*) FROM assets WHERE id=?", (ids[1],))[0][0],
        }

        # 5. 30 天自动清理：把 deleted_at 改成 40 天前
        py("record-trash", "--ids", ids[2])
        exec_sql(
            "UPDATE assets SET deleted_at=datetime('now','localtime','-40 days') WHERE id=?",
            (ids[2],),
        )
        expired = py("trash-expired", "--days", "30")
        result["expired"] = {
            "ids": expired.get("ids"),
            "target_included": ids[2] in (expired.get("ids") or []),
        }
        # 走与启动钩子完全相同的清理顺序（先移文件、再删行）
        if ids[2] in (expired.get("ids") or []):
            if files[2].exists():
                subprocess.run(
                    ["osascript", "-e", f'tell application "Finder" to delete POSIX file "{files[2]}"'],
                    capture_output=True, text=True,
                )
            py("trash-empty", "--ids", ids[2])
            time.sleep(0.5)
        result["expired"]["row_left"] = q("SELECT count(*) FROM assets WHERE id=?", (ids[2],))[0][0]
        result["expired"]["file_in_trash"] = [p.name for p in TRASH.glob("sgs-expired*")]
        result["expired"]["file_gone"] = not files[2].exists()

        result["trash_count"] = q("SELECT count(*) FROM assets WHERE deleted_at IS NOT NULL")[0][0]
    finally:
        cleanup(ids, files)
        result["baseline_assets"] = baseline
        result["final_assets"] = q("SELECT count(*) FROM assets")[0][0]
        result["baseline_deleted"] = deleted_baseline
        result["final_deleted"] = q("SELECT count(*) FROM assets WHERE deleted_at IS NOT NULL")[0][0]
        result["leftover_rows"] = q(
            "SELECT count(*) FROM assets WHERE id LIKE ?", (f"{PREFIX}%",)
        )[0][0]
        result["leftover_files"] = [str(p) for p in TEST_DIR.glob("sgs-*")] + [
            p.name for p in TRASH.glob("sgs-*")
        ]

    ok = (
        result["soft_delete"]["deleted_at_set"]
        and result["soft_delete"]["file_still_there"]
        and result["soft_delete"]["assets_total_after"] == baseline + 3
        and result["soft_delete"]["visible_after"] == visible_baseline + 2
        and result["restore"]["deleted_at"] is None
        and result["restore"]["visible_after"] == visible_baseline + 3
        and result["purge"]["finder_moved"]
        and result["purge"]["file_gone"]
        and result["purge"]["row_left"] == 0
        and bool(result["purge"]["in_system_trash"])
        and result["expired"]["target_included"]
        and result["expired"]["row_left"] == 0
        and result["final_assets"] == baseline
        and result["final_deleted"] == deleted_baseline
        and result["leftover_rows"] == 0
        and not result["leftover_files"]
    )
    result["ok"] = ok
    print(json.dumps(result, ensure_ascii=False, indent=1))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
