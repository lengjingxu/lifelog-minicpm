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
    parser.add_argument("--full-quality", type=int, default=86, help="1600px 大图的 JPEG 质量，默认 86（降到 78 可省约三分之一磁盘）")
    parser.add_argument("--no-ffmpeg", action="store_true", help="不调用 ffmpeg（视频将没有封面）")
    parser.add_argument("--retry-broken", action="store_true", help="重试 thumbs/broken.json 里记录过的失败项")
    return parser.parse_args()




def ffmpeg_poster(source: Path, target: Path, max_side: int, quality: int) -> bool:
    """视频抽首帧；sips 解不了的图片也走这里兜底。"""
    if not shutil_which("ffmpeg"):
        return False
    qscale = max(2, min(31, int(31 - quality / 4)))
    for seek in ("1", "0.2", "0"):
        command = [
            "ffmpeg", "-y", "-loglevel", "error", "-ss", seek, "-i", str(source),
            "-frames:v", "1", "-vf", f"scale='min({max_side},iw)':-2",
            "-q:v", str(qscale), str(target),
        ]
        try:
            result = subprocess.run(command, capture_output=True, text=True, timeout=120)
        except (subprocess.TimeoutExpired, OSError):
            continue
        if result.returncode == 0 and target.exists() and target.stat().st_size > 0:
            return True
    target.unlink(missing_ok=True)
    return False


def diagnose(source: Path) -> str:
    """失败时把文件类型和前 8 字节带上，省得回查。"""
    kind = "?"
    try:
        out = subprocess.run(["file", "-b", str(source)], capture_output=True, text=True, timeout=10)
        kind = (out.stdout or "").strip()[:60] or "?"
    except (subprocess.SubprocessError, OSError):
        pass
    head = ""
    try:
        with source.open("rb") as handle:
            head = handle.read(8).hex()
    except OSError:
        pass
    return f"{kind} head={head}"



def process(row, home: Path, thumbs_dir: Path, full_dir: Path, force: bool,
            full_quality: int, use_ffmpeg: bool,
            broken: set, retry_broken: bool) -> tuple[str, str]:
    asset_id = row["id"]
    if asset_id in broken and not retry_broken:
        return "broken", asset_id
    kind = (row["kind"] or "image").lower()
    source = Path(row["path"])
    if not source.is_absolute():
        source = home / source
    if not source.exists():
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

    if kind == "video" and use_ffmpeg:
        ok_thumb = thumb.exists() or ffmpeg_poster(source, thumb, 360, 78)
        ok_full = full.exists() or ffmpeg_poster(source, full, 1600, full_quality)
        if ok_thumb and ok_full:
            return "poster", asset_id
        return "failed", f"{asset_id}: 视频抽帧失败 thumb={ok_thumb} full={ok_full} · {diagnose(source)}"

    expensive = source.suffix.lower() in (".heic", ".heif")
    if expensive:
        # HEIC 解码最贵：先出 1600，再从 1600 缩 360，省一次 HEIC 解码（实测 -11%，输出一致）
        ok_full = full.exists() or generate_with_retry(source, full, 1600, full_quality)
        ok_thumb = thumb.exists() or (
            ok_full and generate_with_retry(full, thumb, 360, 78)
        ) or generate_with_retry(source, thumb, 360, 78)
    else:
        ok_thumb = thumb.exists() or generate_with_retry(source, thumb, 360, 78)
        ok_full = full.exists() or generate_with_retry(source, full, 1600, full_quality)
    if ok_thumb and ok_full:
        return "ok", asset_id
    if use_ffmpeg:
        ok_thumb = thumb.exists() or ffmpeg_poster(source, thumb, 360, 78)
        ok_full = full.exists() or ffmpeg_poster(source, full, 1600, full_quality)
        if ok_thumb and ok_full:
            return "poster", asset_id
    return "failed", f"{asset_id}: 编码失败 thumb={ok_thumb} full={ok_full} · {diagnose(source)}"


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
        f"SELECT id, path, kind FROM assets ORDER BY taken_at DESC, day DESC{limit_sql}", params
    ).fetchall()
    conn.close()

    broken_path = thumbs_dir / "broken.json"
    try:
        broken_ids = set(json.loads(broken_path.read_text(encoding="utf-8")).keys())
    except (OSError, ValueError):
        broken_ids = set()

    total = len(rows)
    started_at = time.time()
    counts = {"ok": 0, "poster": 0, "skipped": 0, "broken": 0, "failed": 0}
    failures: list[str] = []
    jobs = max(1, min(args.jobs, 16))

    def emit(done: int) -> None:
        elapsed = time.time() - started_at
        rate = done / elapsed if elapsed > 0 else 0
        eta = int((total - done) / rate) if rate > 0 else None
        if args.json:
            log(json.dumps({
                "total": total, "done": done,
                "ok": counts["ok"], "poster": counts["poster"], "skipped": counts["skipped"], "failed": counts["failed"],
                "elapsed_s": round(elapsed, 1), "rate_per_s": round(rate, 1), "eta_s": eta,
            }, ensure_ascii=False))
        elif done % 25 == 0 or done == total:
            log(f"  [{done}/{total}] ok={counts['ok']} poster={counts['poster']} skip={counts['skipped']} fail={counts['failed']} · {rate:.1f} 张/秒 · 剩余 {eta or 0}s")

    with log_path.open("a", encoding="utf-8") as log_file, ThreadPoolExecutor(max_workers=jobs) as pool:
        def record(line: str) -> None:
            log_file.write(line + chr(10))

        record(f"[{datetime.now().isoformat(timespec='seconds')}] 开始 {total} 张 · jobs={jobs} · home={home}")
        futures = [pool.submit(process, row, home, thumbs_dir, full_dir, args.force, args.full_quality, not args.no_ffmpeg, broken_ids, args.retry_broken) for row in rows]
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

    if failures:
        try:
            existing = json.loads(broken_path.read_text(encoding="utf-8")) if broken_path.exists() else {}
        except ValueError:
            existing = {}
        for line in failures:
            asset_id = line.split(":", 1)[0]
            existing[asset_id] = line
        broken_path.write_text(json.dumps(existing, ensure_ascii=False, indent=1), encoding="utf-8")

    summary = {
        "total": total, **counts, "jobs": jobs,
        "elapsed_s": round(time.time() - started_at, 1),
        "failures": failures[:50],
    }
    if args.json:
        log(json.dumps(summary, ensure_ascii=False))
    else:
        log(f"完成：ok={counts['ok']} poster={counts['poster']} skipped={counts['skipped']} failed={counts['failed']} · {summary['elapsed_s']}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
