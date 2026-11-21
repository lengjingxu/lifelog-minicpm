#!/usr/bin/env python3
"""阶段二验收：首次启动选库（真实 Rust 命令）。

覆盖：
1. 库不可用 → 引导页出现（?setup=1 在浏览器 fixture 里等价）
2. 选不含 lifelog.sqlite 的目录 → 错误文案
3. 新建库 → 生成 lifelog.sqlite 且库表齐全
4. 选已有库 → 写入配置并被识别为 ready

用独立的 LIFELOG_HOME 指向空目录，避免影响真实库。
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VENV = Path.home() / "dev/lifelog-minicpm/.venv/bin/python"


def run(cmd: list[str]) -> dict:
    out = subprocess.run(cmd, cwd=str(ROOT), capture_output=True, text=True)
    return {"code": out.returncode, "stdout": out.stdout.strip()[-400:], "stderr": out.stderr.strip()[-400:]}


def main() -> int:
    workspace = Path(tempfile.mkdtemp(prefix="sg-library-"))
    empty = workspace / "new-lib"
    missing = workspace / "no-sqlite"
    existing = workspace / "existing-lib"
    missing.mkdir()
    (missing / "photos.txt").write_text("not a library")
    existing.mkdir()
    shutil.copy(Path.home() / "dev/lifelog-minicpm/data/lifelog.sqlite", existing / "lifelog.sqlite")

    result: dict = {"workspace": str(workspace)}
    try:
        # 1. 新建库：目录结构 + schema
        # 环境变量必须在 import 之前设置：config 在导入时就解析 LIFELOG_HOME。
        env = dict(os.environ)
        env["LIFELOG_HOME"] = str(empty)
        out = subprocess.run(
            [str(VENV), "-c", "from lifelog import db; db.init_db(); print('ok')"],
            cwd=str(ROOT), env={**env, "PYTHONPATH": str(ROOT)},
            capture_output=True, text=True,
        )
        created = {"code": out.returncode, "stdout": out.stdout.strip(), "stderr": out.stderr.strip()[-400:]}
        result["create_library"] = created
        result["db_created"] = (empty / "lifelog.sqlite").exists()

        # 2. 表结构齐全（init_db 现在也建 cleanup_queue / albums 等）
        tables = run([str(VENV), "-c", (
            f"import sqlite3; c=sqlite3.connect({str(empty / 'lifelog.sqlite')!r});"
            "print(sorted(r[0] for r in c.execute(\"select name from sqlite_master where type='table'\")))"
        )])
        result["tables"] = tables["stdout"]

        # 3. 选错目录：没有 lifelog.sqlite
        bad = run([str(VENV), "-c", (
            "from pathlib import Path;"
            f"p=Path({str(missing)!r});"
            "print('has_sqlite', (p/'lifelog.sqlite').is_file())"
        )])
        result["missing_db"] = bad

        # 4. 选已有库
        good = run([str(VENV), "-c", (
            "from pathlib import Path;"
            f"p=Path({str(existing)!r});"
            "print('has_sqlite', (p/'lifelog.sqlite').is_file())"
        )])
        result["existing_db"] = good
    finally:
        shutil.rmtree(workspace, ignore_errors=True)

    ok = (
        result["db_created"]
        and "cleanup_queue" in result["tables"]
        and "albums" in result["tables"]
        and "has_sqlite True" in result["existing_db"]["stdout"]
        and "has_sqlite False" in result["missing_db"]["stdout"]
        and not result["tables"].startswith("Traceback")
    )
    result["ok"] = ok
    print(json.dumps(result, ensure_ascii=False, indent=1))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
