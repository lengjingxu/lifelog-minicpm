
"""资产路径解析：库搬过家之后，assets.path 里存的绝对路径会失效。

按 photos/月份/文件名 的相对位置回找；找不到就原样返回，让调用方按缺文件处理。
"""
from __future__ import annotations

from pathlib import Path

from . import config


def resolve(raw: str | Path) -> Path:
    path = Path(raw)
    if not path.is_absolute():
        path = config.DATA_DIR / path
    if path.exists():
        return path
    parts = Path(raw).parts
    if len(parts) >= 2:
        candidate = config.DATA_DIR / "photos" / Path(*parts[-2:])
        if candidate.exists():
            return candidate
    return path


def thumb(asset_id: str) -> Path | None:
    """优先缩略图：解码 256px 比原图快一个数量级。"""
    for candidate in (
        config.DATA_DIR / "thumbs" / f"{asset_id}.jpg",
        config.DATA_DIR / "thumbs" / "full" / f"{asset_id}.jpg",
    ):
        if candidate.exists():
            return candidate
    return None

