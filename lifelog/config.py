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
        "ctx": 4096,   # 16 GB 机器上 8B + mmproj 用 8192 会 Metal OOM
        "extra_args": ["--reasoning", "off"],
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


# —— 展示层隐私策略（人生回顾页 / 人生经历 MCP）——
# 只展示这个日期之后的照片，避免把早年居家、孩子等画面暴露在外
REVIEW_SINCE_DAY = os.environ.get("LIFELOG_REVIEW_SINCE", "2023-01-01")
# 每段生活片段最多展示几张照片
REVIEW_PHOTOS_PER_EVENT = int(os.environ.get("LIFELOG_REVIEW_PHOTOS", "3"))
# 需要额外排除的标签，逗号分隔，例如 "儿童,室内居家"
REVIEW_EXCLUDE_TAGS = [t.strip() for t in
                       os.environ.get(
                           "LIFELOG_REVIEW_EXCLUDE_TAGS",
                           "屏幕截图,文字排版,图表数据,文档票据").split(",") if t.strip()]

# —— 标签词表 ——
# 自建模型（MiniCPM）用 17 类粗分类；迁移进来的旧模型（Qwen3-VL）用的是更细的
# 自由词表。两边都保留原词，但统一映射到下面这套「主类」，统计与检索都按主类走，
# 这样两批结果能合在一起算，也不会因为换模型而让统计口径漂移。
TAG_TAXONOMY = {
    "人物": ["人物"],
    "风景": ["风景", "户外", "山野", "海边", "湖泊", "雪地", "日出", "日落", "天空", "自然"],
    "城市建筑": ["城市建筑", "街道", "建筑", "招牌", "车辆", "交通出行", "交通"],
    "室内居家": ["室内居家", "室内", "家具", "家居", "厨房", "客厅", "卧室"],
    "美食": ["美食", "餐具", "餐厅", "蛋糕", "饮品", "食物"],
    "植物花卉": ["植物花卉", "花朵", "植物", "花卉"],
    "活动聚会": ["活动聚会", "舞台", "表演", "聚会", "合影"],
    "运动户外": ["运动户外", "运动", "骑行", "徒步", "游泳"],
    "儿童": ["儿童", "玩具", "婴儿", "孩子"],
    "宠物动物": ["宠物动物", "宠物", "动物"],
    "文档票据": ["文档票据", "文字", "二维码", "票据", "文档"],
    "屏幕截图": ["屏幕截图", "手机", "电脑", "截图"],
    "文字排版": ["文字排版"],
    "图表数据": ["图表数据", "图表"],
    "商品物品": ["商品物品", "商品", "物品"],
    "艺术绘画": ["艺术绘画", "绘画", "艺术"],
    "交通出行": ["交通出行", "交通"],
}

# 反向索引：原词 -> 主类
TAXONOMY_ORDER = list(TAG_TAXONOMY)

TAG_TO_CATEGORY = {alias: cat for cat, aliases in TAG_TAXONOMY.items() for alias in aliases}


def canonical_tags(tags) -> list[str]:
    """把任意模型的标签归一到主类，去重并按词表顺序排序。"""
    seen = []
    for tag in tags or []:
        name = str(tag).strip()
        if not name:
            continue
        category = TAG_TO_CATEGORY.get(name)
        if category is None:
            for alias, cat in TAG_TO_CATEGORY.items():
                if alias in name or name in alias:
                    category = cat
                    break
        if category and category not in seen:
            seen.append(category)
    order = {name: i for i, name in enumerate(TAG_TAXONOMY)}
    return sorted(seen, key=lambda t: order.get(t, 99))
