"""把多个模型的描述合并成一张 merged_caption 表（供 current_caption 视图使用）。

规则见 scripts/merge_captions.py 的说明；这里提供可 import 的入口，方便管线调用。
"""
from __future__ import annotations

import sys
from pathlib import Path

_SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

import merge_captions as _impl  # noqa: E402


def run() -> dict:
    """重建 merged_caption 并刷新 current_caption 视图。"""
    import io
    import json
    from contextlib import redirect_stdout

    buffer = io.StringIO()
    with redirect_stdout(buffer):
        _impl.main()
    for line in buffer.getvalue().splitlines()[::-1]:
        line = line.strip()
        if line.startswith("{"):
            return json.loads(line)
    return {}
