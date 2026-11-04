"""资产登记：扫描本地相册目录，写入 assets 表。"""
from __future__ import annotations

import hashlib
import os
import time
from datetime import datetime, timezone
from pathlib import Path

from . import config, db

SKIP_DIRS = {"$RECYCLE.BIN", "RECYCLER", "System Volume Information", ".Spotlight-V100",
             ".Trashes", ".fseventsd", "lost+found", ".git", "node_modules", ".venv"}
SKIP_SUFFIX_DIRS = (".photoslibrary", ".photolibrary", ".lrdata", ".lrlibrary")


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def asset_id(path: Path, size: int, mtime: float, content_hash: bool = False) -> str:
    if content_hash:
        digest = hashlib.sha1()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1 << 20), b""):
                digest.update(chunk)
        return digest.hexdigest()[:16]
    raw = f"{path}:{size}:{mtime:.3f}".encode()
    return hashlib.sha1(raw).hexdigest()[:16]


def exif_info(path: Path) -> tuple[str | None, float | None, float | None]:
    """返回 (拍摄时间 ISO, 纬度, 经度)。"""
    try:
        from PIL import Image
        from PIL.ExifTags import GPSTAGS

        with Image.open(path) as image:
            exif = image.getexif()
            taken = None
            for tag in (36867, 36868, 306):
                value = exif.get(tag)
                if value:
                    taken = str(value)
                    break
            lat = lon = None
            gps = exif.get_ifd(0x8825) if hasattr(exif, "get_ifd") else None
            if gps:
                def to_deg(pair):
                    if not pair:
                        return None
                    d, m, s = pair
                    return float(d) + float(m) / 60 + float(s) / 3600

                lat = to_deg(gps.get(2))
                lon = to_deg(gps.get(4))
                if lat is not None and gps.get(1) == "S":
                    lat = -lat
                if lon is not None and gps.get(3) == "W":
                    lon = -lon
            return taken, lat, lon
    except Exception:
        return None, None, None


def iter_media(roots: list[str]):
    for root in roots:
        base = Path(root).expanduser()
        if not base.exists():
            continue
        if base.is_file():
            yield base
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [
                d for d in dirnames
                if d not in SKIP_DIRS and not d.startswith("._") and not d.endswith(SKIP_SUFFIX_DIRS)
            ]
            for name in filenames:
                if name.startswith("._") or name.startswith("."):
                    continue
                suffix = Path(name).suffix.lower()
                if suffix in config.IMAGE_EXTS or suffix in config.VIDEO_EXTS:
                    yield Path(dirpath) / name


def parse_exif_time(raw: str | None) -> tuple[str | None, str | None]:
    if not raw:
        return None, None
    for fmt in ("%Y:%m:%d %H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y:%m:%d %H:%M"):
        try:
            dt = datetime.strptime(raw.strip().rstrip("\x00"), fmt)
            return dt.isoformat(timespec="seconds"), dt.strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None, None


def ingest(roots: list[str], content_hash: bool = False, limit: int | None = None) -> dict:
    db.init_db()
    stats = {"seen": 0, "new": 0, "updated": 0, "skipped": 0}
    with db.session() as con:
        for path in iter_media(roots):
            stats["seen"] += 1
            if limit and stats["seen"] > limit:
                break
            try:
                stat = path.stat()
            except OSError:
                stats["skipped"] += 1
                continue
            aid = asset_id(path, stat.st_size, stat.st_mtime, content_hash)
            kind = "video" if path.suffix.lower() in config.VIDEO_EXTS else "image"
            existing = con.execute("SELECT id, size, mtime FROM assets WHERE path=?",
                                   (str(path),)).fetchone()
            if existing and existing["id"] == aid:
                stats["skipped"] += 1
                continue
            taken, lat, lon = exif_info(path) if kind == "image" else (None, None, None)
            taken_at, day = parse_exif_time(taken)
            if not taken_at:
                mtime_dt = datetime.fromtimestamp(stat.st_mtime)
                taken_at = mtime_dt.isoformat(timespec="seconds")
                day = mtime_dt.strftime("%Y-%m-%d")
            con.execute(
                """INSERT INTO assets (id, path, size, mtime, taken_at, day, lat, lon, kind, created_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(id) DO UPDATE SET
                     path=excluded.path, size=excluded.size, mtime=excluded.mtime,
                     taken_at=excluded.taken_at, day=excluded.day, lat=excluded.lat,
                     lon=excluded.lon, kind=excluded.kind""",
                (aid, str(path), stat.st_size, stat.st_mtime, taken_at, day, lat, lon, kind, now_iso()),
            )
            stats["new"] += 1
    return stats
