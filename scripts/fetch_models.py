#!/usr/bin/env python3
"""下载 MiniCPM 官方 GGUF（默认走 hf-mirror 镜像，可断点续传）。"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lifelog import config  # noqa: E402

FILES = {
    "minicpm-v-4.7-1b": [
        ("MiniCPM-V-4_7-1B-Q8_0.gguf", 1081517920),
        ("mmproj-model-f16.gguf", 1110117984),
    ],
    "minicpm-v-4.5-8b": [
        ("MiniCPM-V-4_5-Q4_K_M.gguf", 5030000000),
        ("mmproj-model-f16.gguf", 1100000000),
    ],
    "minicpm-ocr-1.0": [
        ("MiniCPM-OCR-1_0-Q8_0.gguf", 810000000),
        ("mmproj-model-f16-4x.gguf", 900000000),
    ],
    "minicpm-ocr-jev": [
        ("MiniCPM-OCR-Jev-Q8_0.gguf", 2010000000),
        ("mmproj-model-f16.gguf", 670000000),
    ],
}


def fetch(url: str, target: Path) -> bool:
    target.parent.mkdir(parents=True, exist_ok=True)
    cmd = ["curl", "-L", "--fail", "-C", "-", "--retry", "5", "--retry-delay", "3",
           "--connect-timeout", "20", "-o", str(target), url]
    result = subprocess.run(cmd)
    return result.returncode == 0 and target.exists() and target.stat().st_size > 1024


def main() -> int:
    parser = argparse.ArgumentParser(description="下载 MiniCPM 模型")
    parser.add_argument("model", nargs="?", default="all",
                        help="模型 key 或 all，可选: " + ", ".join(FILES))
    parser.add_argument("--endpoint", default=config.HF_MIRROR)
    args = parser.parse_args()

    keys = list(FILES) if args.model == "all" else [args.model]
    for key in keys:
        if key not in FILES:
            print(f"未知模型 {key}", file=sys.stderr)
            return 2
        repo = config.REPOS[key]
        target_dir = config.MODELS_DIR / config.MODELS[key]["dir"]
        print(f"== {key} -> {target_dir}")
        for name, _size in FILES[key]:
            url = f"{args.endpoint}/{repo}/resolve/main/{name}"
            target = target_dir / name
            if target.exists():
                print(f"  已存在 {name} ({target.stat().st_size/1e9:.2f} GB)，跳过")
                continue
            print(f"  下载 {name} ...")
            if not fetch(url, target):
                print(f"  失败 {name}", file=sys.stderr)
                return 1
            print(f"  完成 {name} ({target.stat().st_size/1e9:.2f} GB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
