"""路径与模型注册表配置。"""
from __future__ import annotations

import os
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("LIFELOG_HOME", ROOT / "data")).expanduser()
DB_PATH = Path(os.environ.get("LIFELOG_DB", DATA_DIR / "lifelog.sqlite")).expanduser()
MODELS_DIR = Path(os.environ.get("LIFELOG_MODELS_DIR", "/Volumes/Leng/Models")).expanduser()
LOG_DIR = DATA_DIR / "logs"

LLAMA_SERVER_BIN = shutil.which("llama-server") or "llama-server"
SERVER_HOST = "127.0.0.1"

# 模型注册表：全部为 MiniCPM 系列官方 GGUF，本地 llama.cpp 推理。
MODELS: dict[str, dict] = {
    "minicpm-v-4.7-1b": {
        "title": "MiniCPM-V-4.7-1B",
        "dir": "minicpm-v-4.7-1b",
        "gguf": "MiniCPM-V-4_7-1B-Q8_0.gguf",
        "mmproj": "mmproj-model-f16.gguf",
        "ctx": 8192,
        "role": "全库识别：端侧轻量，逐张出结构化描述与标签",
    },
    "minicpm-v-4.5-8b": {
        "title": "MiniCPM-V-4.5-8B",
        "dir": "minicpm-v-4.5-8b",
        "gguf": "MiniCPM-V-4_5-Q4_K_M.gguf",
        "mmproj": "mmproj-model-f16.gguf",
        "ctx": 8192,
        "role": "深度理解：对重点照片与成组照片做细粒度解读",
    },
    "minicpm-ocr-1.0": {
        "title": "MiniCPM-OCR-1.0",
        "dir": "minicpm-ocr-1.0",
        "gguf": "MiniCPM-OCR-1_0-Q8_0.gguf",
        "mmproj": "mmproj-model-f16-4x.gguf",
        "ctx": 8192,
        "extra_args": ["--jinja", "--reasoning", "off"],
        "role": "图内文字：截屏、票据、路牌、招牌的结构化抽取",
    },
    "minicpm-ocr-jev": {
        "title": "MiniCPM-OCR-Jev",
        "dir": "minicpm-ocr-jev",
        "gguf": "MiniCPM-OCR-Jev-Q8_0.gguf",
        "mmproj": "mmproj-model-f16.gguf",
        "ctx": 8192,
        "extra_args": ["--jinja", "--reasoning", "off"],
        "role": "图内文字：Jev 版，与 1.0 互为备份",
    },
}

# 官方 GGUF 仓库（hf-mirror 为国内可用镜像）
HF_MIRROR = os.environ.get("LIFELOG_HF_ENDPOINT", "https://hf-mirror.com")
REPOS = {
    "minicpm-v-4.7-1b": "openbmb/MiniCPM-V-4.7-1B-gguf",
    "minicpm-v-4.5-8b": "openbmb/MiniCPM-V-4_5-gguf",
    "minicpm-ocr-1.0": "openbmb/MiniCPM-OCR-1.0-gguf",
    "minicpm-ocr-jev": "openbmb/MiniCPM-OCR-Jev-gguf",
}

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".avif"}
VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".avi", ".mkv"}

TAGS = [
    "人物", "美食", "风景", "城市建筑", "宠物动物", "植物花卉", "儿童",
    "活动聚会", "运动户外", "交通出行", "室内居家", "文档票据", "屏幕截图",
    "图表数据", "商品物品", "艺术绘画", "文字排版",
]
