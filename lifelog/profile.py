"""生活画像：把统计底稿交给 MiniCPM，写成一段能被 AI 直接读的人生摘要。"""
from __future__ import annotations

from datetime import datetime, timezone

from . import aggregate, config, db, models

PROMPT_VERSION = "profile-v1"

PROMPT = (
    "下面是一个人的私人相册被本地视觉模型识别后得到的统计底稿。"
    "请用中文写一份「这个人的生活画像」，让人（或 AI）读完就能大致了解这个人怎么生活。"
    "要求：\n"
    "1) 用 6-10 段短文字分段，覆盖：生活节奏与作息、常见场景与地点、社交与独处、"
    "兴趣与活动、情绪基调、季节/时段偏好、明显的生活变化；\n"
    "2) 只使用底稿里出现的信息，不要编造具体人名、地名或事件；\n"
    "3) 语气具体、有画面感，像一份朋友写的观察日记，不要用报告腔；\n"
    "4) 不使用 Markdown 标题和列表符号，只写段落。\n\n"
    "统计底稿：\n{stats}"
)


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def build_profile(model_key: str = "minicpm-v-4.7-1b", describe_model: str | None = None,
                  since_day=None, until_day=None) -> dict:
    stats = aggregate.compute_stats(describe_model, since_day, until_day)
    text = aggregate.stats_to_text(stats)
    if stats["described"] == 0:
        raise RuntimeError("还没有任何已识别的照片，先跑 lifelog caption")
    with models.Server(model_key) as server:
        narrative = server.chat(PROMPT.format(stats=text), max_tokens=1200, temperature=0.4, timeout=600)
    entries = {
        "summary": narrative,
        "stats": text,
        "top_tags": db.jdump(stats["top_tags"]),
        "top_places": db.jdump(stats["top_places"]),
        "top_activities": db.jdump(stats["top_activities"]),
        "rhythm": db.jdump(stats["hour_histogram"]),
        "coverage": f"{stats['coverage']:.2%}",
    }
    with db.session() as con:
        for key, value in entries.items():
            con.execute(
                """INSERT INTO profile (key, value, evidence, updated_at) VALUES (?,?,?,?)
                   ON CONFLICT(key) DO UPDATE SET value=excluded.value,
                     evidence=excluded.evidence, updated_at=excluded.updated_at""",
                (key, value, stats["described"], now_iso()),
            )
    return {"stats": stats, "narrative": narrative}


def get_profile() -> dict:
    db.init_db()
    with db.session() as con:
        rows = con.execute("SELECT key, value, evidence, updated_at FROM profile").fetchall()
    return {row["key"]: row["value"] for row in rows}
