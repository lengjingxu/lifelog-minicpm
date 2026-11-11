#!/usr/bin/env python3
"""Generate two-level JPEG thumbnails for the local lifelog library.

The desktop client expects thumbs/{id}.jpg (360px, grid) and
thumbs/full/{id}.jpg (1600px, detail). This script follows the cache layout used
by lifelog/web.py, but uses macOS sips so the desktop build does not need PIL or
pillow-heif. The SQLite database is opened read-only and is never modified.
"""

from __future__ import annotations

import argparse
import os
import sqlite3
import subprocess
import time
import json
from concurrent.futures import ThreadPoolExecutor, as_completed
import sys
from datetime import datetime
from pathlib import Path

DEFAULT_HOME = Path(__file__).resolve().parent.parent / "sample-data"


def log(message: str) -> None:
    print(message, flush=True)


def shutil_which(name: str) -> str | None:
    for directory in os.environ.get("PATH", "").split(os.pathsep):
        candidate = Path(directory) / name
        if candidate.exists() and os.access(candidate, os.X_OK):
            return str(candidate)
    return None


def run_sips(source: Path, target: Path, max_side: int, quality: int) -> tuple[bool, str]:
    command = [
        "sips", "-Z", str(max_side),
        "-s", "format", "jpeg",
        "-s", "formatOptions", str(quality),
        str(source), "--out", str(target),
    ]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=90)
    except Exception as exc:  # noqa: BLE001 - report the failing asset and continue
        return False, str(exc)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "sips failed").strip().splitlines()
        return False, detail[-1] if detail else "sips failed"
    if not target.exists() or target.stat().st_size == 0:
        return False, "sips produced no output"
    return True, ""


def generate_with_retry(source: Path, target: Path, max_side: int, quality: int) -> bool:
    target.parent.mkdir(parents=True, exist_ok=True)
    for attempt in (1, 2):
        if target.exists() and target.stat().st_size > 0:
            return True
        ok, error = run_sips(source, target, max_side, quality)
        if ok:
            return True
        log(f"  尝试 {attempt}/2 失败: {error}")
        if target.exists():
            target.unlink(missing_ok=True)
    return False


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="生成拾光两级缩略图（sips）")
    parser.add_argument("--home", type=Path, help="LIFELOG_HOME，默认取环境变量或 sample-data")
    parser.add_argument("--limit", type=int, default=0, help="只处理前 N 条，0 表示全部")
    parser.add_argument("--force", action="store_true", help="覆盖已存在的缩略图")
    parser.add_argument("--jobs", type=int, default=6, help="并行度，默认 6（sips 是独立进程）")
    parser.add_argument("--json", action="store_true", help="按行输出 JSON 进度，便于 UI/脚本消费")
    return parser.parse_args()


def process(row, home: Path, thumbs_dir: Path, full_dir: Path, force: bool) -> tuple[str, str]:
    asset_id = row["id"]
    source = Path(row["path"])
    if not source.is_absolute():
        source = home / source
    if not source.exists():
        # 库挪过位置时，绝对路径会指向旧目录：按 photos/ 之后的部分重新拼一次。
        marker = "/photos/"
        raw = str(source)
        if marker in raw:
            source = home / "photos" / raw.split(marker, 1)[1]
    thumb = thumbs_dir / f"{asset_id}.jpg"
    full = full_dir / f"{asset_id}.jpg"
    if not source.exists():
        return "failed", f"{asset_id}: 原图不存在 {source}"
    if force:
        thumb.unlink(missing_ok=True)
        full.unlink(missing_ok=True)
    if thumb.exists() and full.exists():
        return "skipped", asset_id
    ok_thumb = thumb.exists() or generate_with_retry(source, thumb, 360, 78)
    ok_full = full.exists() or generate_with_retry(source, full, 1600, 86)
    if ok_thumb and ok_full:
        return "ok", asset_id
    return "failed", f"{asset_id}: 缩略图={ok_thumb} 大图={ok_full}"


def main() -> int:
    args = parse_args()
    home_env = os.environ.get("LIFELOG_HOME")
    home = args.home or (Path(home_env) if home_env else DEFAULT_HOME)
    home = home.expanduser().resolve()
    db_path = Path(os.environ.get("LIFELOG_DB", home / "lifelog.sqlite"))
    if not db_path.exists():
        log(f"找不到数据库: {db_path}")
        return 1
    if not shutil_which("sips"):
        log("找不到 macOS sips 命令")
        return 1

    thumbs_dir = home / "thumbs"
    full_dir = thumbs_dir / "full"
    log_path = thumbs_dir / "generate.log"
    thumbs_dir.mkdir(parents=True, exist_ok=True)
    full_dir.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    limit_sql = " LIMIT ?" if args.limit > 0 else ""
    params = (args.limit,) if args.limit > 0 else ()
    rows = conn.execute(
        f"SELECT id, path FROM assets ORDER BY taken_at DESC, day DESC{limit_sql}", params
    ).fetchall()
    conn.close()

    total = len(rows)
    started_at = time.time()
    counts = {"ok": 0, "skipped": 0, "failed": 0}
    failures: list[str] = []
    jobs = max(1, min(args.jobs, 16))

    def emit(done: int) -> None:
        elapsed = time.time() - started_at
        rate = done / elapsed if elapsed > 0 else 0
        eta = int((total - done) / rate) if rate > 0 else None
        if args.json:
            log(json.dumps({
                "total": total, "done": done,
                "ok": counts["ok"], "skipped": counts["skipped"], "failed": counts["failed"],
                "elapsed_s": round(elapsed, 1), "rate_per_s": round(rate, 1), "eta_s": eta,
            }, ensure_ascii=False))
        elif done % 25 == 0 or done == total:
            log(f"  [{done}/{total}] ok={counts['ok']} skip={counts['skipped']} fail={counts['failed']} · {rate:.1f} 张/秒 · 剩余 {eta or 0}s")

    with log_path.open("a", encoding="utf-8") as log_file, ThreadPoolExecutor(max_workers=jobs) as pool:
        def record(line: str) -> None:
            log_file.write(line + chr(10))

        record(f"[{datetime.now().isoformat(timespec='seconds')}] 开始 {total} 张 · jobs={jobs} · home={home}")
        futures = [pool.submit(process, row, home, thumbs_dir, full_dir, args.force) for row in rows]
        for done, future in enumerate(as_completed(futures), 1):
            status, detail = future.result()
            counts[status] += 1
            if status == "failed":
                failures.append(detail)
                record(f"  failed {detail}")
            if args.json:
                if done % 25 == 0 or done == total:
                    emit(done)
            else:
                emit(done)
        record(f"[{datetime.now().isoformat(timespec='seconds')}] 完成 ok={counts['ok']} skip={counts['skipped']} fail={counts['failed']}")

    summary = {
        "total": total, **counts, "jobs": jobs,
        "elapsed_s": round(time.time() - started_at, 1),
        "failures": failures[:50],
    }
    if args.json:
        log(json.dumps(summary, ensure_ascii=False))
    else:
        log(f"完成：ok={counts['ok']} skipped={counts['skipped']} failed={counts['failed']} · {summary['elapsed_s']}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
