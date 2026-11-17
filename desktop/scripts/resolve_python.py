"""Rust 侧统一从 stdin 读的 Python 解释器解析结果。"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent


def candidates() -> list[str]:
    found: list[str] = []
    override = os.environ.get("LIFELOG_PYTHON", "").strip()
    if override:
        found.append(override)
    roots = [REPO]
    home = os.environ.get("LIFELOG_HOME", "").strip()
    if home:
        data = Path(home).expanduser()
        roots.extend([data.parent, data])
    for root in roots:
        venv = root / ".venv" / "bin" / "python"
        if venv.exists():
            found.append(str(venv))
    for name in ("python3", "python"):
        path = shutil.which(name)
        if path:
            found.append(path)
    seen: set[str] = set()
    unique: list[str] = []
    for item in found:
        key = os.path.abspath(os.path.expanduser(item))
        if key not in seen:
            seen.add(key)
            unique.append(key)
    return unique


def has_pillow(python: str) -> bool:
    try:
        result = subprocess.run(
            [python, "-c", "import PIL"],
            capture_output=True, text=True, timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0


def main() -> int:
    for candidate in candidates():
        if has_pillow(candidate):
            print(candidate)
            return 0
    print("找不到带 Pillow 的 Python，请设置 LIFELOG_PYTHON")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())

