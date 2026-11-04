"""人生回顾页：把相册串成一条可交互的沉浸式时间线。

页面模板在 lifelog/assets/review.html，数据由本地库注入，不依赖任何前端框架。
"""
from __future__ import annotations

import json
from pathlib import Path

from . import config, db, journey, story

TEMPLATE = Path(__file__).resolve().parent / "assets" / "review.html"


def _tags_of(photo: dict) -> list:
    tags = photo.get("tags")
    if isinstance(tags, str):
        return db.jload(tags)
    return tags or []


def _cover(photos: list[dict]) -> str:
    """封面图：优先纯风景（不要人物），其次带风景的，最后第一张。"""
    scenic = [p for p in photos
              if "风景" in _tags_of(p) and "人物" not in _tags_of(p)]
    if scenic:
        return scenic[len(scenic) // 2]["id"]
    for photo in photos:
        if "风景" in _tags_of(photo):
            return photo["id"]
    return photos[0]["id"] if photos else ""


def build_data(photos_per_event: int | None = None) -> dict:
    photos_per_event = photos_per_event or config.REVIEW_PHOTOS_PER_EVENT
    data = journey.build_journey(photos_per_event=photos_per_event,
                                  since_day=config.REVIEW_SINCE_DAY,
                                  exclude_tags=config.REVIEW_EXCLUDE_TAGS)
    years = []
    flat = []
    for section in data["sections"]:
        events = []
        for event in section["events"]:
            photos = []
            for photo in event["photos"]:
                item = {
                    "id": photo["id"],
                    "thumb": f"/thumb/{photo['id']}",
                    "full": f"/photo/{photo['id']}",
                    "day": photo.get("day") or "",
                    "time": (photo.get("taken_at") or "")[11:16],
                    "caption": photo.get("caption") or "",
                    "tags": db.jload(photo.get("tags")),
                    "place": photo.get("place") or "",
                    "activity": photo.get("activity") or "",
                }
                photos.append(item)
                flat.append(item)
            events.append({
                "id": event["id"],
                "start": event["start_day"],
                "end": event["end_day"],
                "title": event["title"],
                "summary": event["summary"] or "",
                "tags": event["tags"],
                "count": event["photo_count"],
                "photos": photos,
            })
        years.append({"year": section["year"], "events": events})
    lede = (data["summary"] or "").strip()
    paragraphs = [p for p in lede.split(chr(10)) if p.strip()]
    meta = dict(data["stats"])
    meta["generated_at"] = data["generated_at"]
    meta["events"] = data["stats"].get("shown_events", 0)
    meta["described"] = data["stats"].get("shown_photos", 0)
    meta["total_assets"] = data["stats"].get("total_assets", 0)
    meta["described_total"] = data["stats"].get("described", 0)
    meta["since_day"] = config.REVIEW_SINCE_DAY
    days = sorted(p["day"] for p in flat if p.get("day"))
    meta["visible_span"] = [days[0], days[-1]] if days else []
    meta["cover"] = _cover(flat)
    stored = db_profile()
    story_text = stored.get("story", "")
    voices = []
    for key, spec in story.VOICES.items():
        text = stored.get(f"story_{key}", "") or (story_text if key == "diary" else "")
        if not text:
            continue
        voices.append({
            "id": key,
            "title": spec["title"],
            "kicker": spec["kicker"],
            "label": spec["label"],
            "text": text,
            "lead": chr(10).join([p for p in text.split(chr(10)) if p.strip()][:2]),
        })
    insight_text = stored.get("insight", "")
    cards = []
    for chunk in insight_text.splitlines():
        chunk = chunk.strip()
        if not chunk:
            continue
        if chunk.startswith("【") and "】" in chunk:
            title = chunk[1:chunk.index("】")]
            body = chunk[chunk.index("】") + 1:].strip()
            cards.append({"title": title, "body": body})
        elif cards:
            cards[-1]["body"] = (cards[-1]["body"] + " " + chunk).strip()
    return {
        "meta": meta,
        "summary": chr(10).join(paragraphs[:2]) if paragraphs else "",
        "full_summary": lede,
        "story": story_text,
        "voices": voices,
        "insight": insight_text,
        "insight_cards": cards,
        "facts": story.render_facts(story.build_facts(config.REVIEW_SINCE_DAY)),
        "years": years,
    }


def db_profile() -> dict:
    from . import profile as profile_mod
    return profile_mod.get_profile()


def render(photos_per_event: int | None = None) -> str:
    template = TEMPLATE.read_text(encoding="utf-8")
    payload = json.dumps(build_data(photos_per_event), ensure_ascii=False)
    return template.replace('{"placeholder":true}', payload)
