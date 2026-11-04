"""lifelog：本地相册 → MiniCPM 识别 → 生活档案 → AI 可查。"""
__version__ = "0.1.0"


# 相册里有超大尺寸照片（120MP+），PIL 默认会告警，这里本地可信来源直接放开
try:
    from PIL import Image

    Image.MAX_IMAGE_PIXELS = None
except Exception:  # pragma: no cover
    pass
