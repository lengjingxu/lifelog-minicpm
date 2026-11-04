"""人生经历：把相册按时间串成一条可读的轨迹。

数据来源全是已有的表，不新增模型调用：
    events（生活片段） + captions（逐张描述） + assets（拍摄时间）
"""
from __future__ import annotations

from datetime import datetime

from . import aggregate, db, profile as profile_mod


def _spread(items: list, count: int) -> list:
    """从有序列表里等距取 count 个，避免全是同一段。"""
    if len(items) <= count:
        return items
    step = len(items) / count
    return [items[int(i * step)] for i in range(count)]


def event_photos(con, start_day: str, end_day: str, count: int = 6) -> list[dict]:
    rows = con.execute(
        """SELECT a.id, a.path, a.day, a.taken_at, c.caption, c.tags, c.place, c.activity
           FROM assets a JOIN captions c ON c.asset_id = a.id
           WHERE c.prompt_version = 'describe-v1' AND c.status = 'ok'
             AND a.day >= ? AND a.day <= ?
           ORDER BY a.taken_at, a.path""",
        (start_day, end_day),
    ).fetchall()
    items = [dict(row) for row in rows]
    picked = _spread(items, count)
    # 标签多样的先留，避免一段里全是同一类
    seen_tags: set[str] = set()
    diverse = []
    for item in picked:
        tags = db.jload(item.get("tags"))
        fresh = [t for t in tags if t not in seen_tags]
        if fresh or len(diverse) < 3:
            diverse.append(item)
            seen_tags.update(tags)
    for item in picked:
        if len(diverse) >= count:
            break
        if item not in diverse:
            diverse.append(item)
    return diverse[:count]


def build_journey(max_events: int = 60, photos_per_event: int = 6) -> dict:
    db.init_db()
    with db.session() as con:
        events = con.execute(
            """SELECT id, start_day, end_day, title, summary, tags, photo_count
               FROM events ORDER BY start_day ASC"""
        ).fetchall()
        sections = []
        for event in events:
            photos = event_photos(con, event["start_day"], event["end_day"], photos_per_event)
            if not photos:
                continue
            year = (event["start_day"] or "")[:4]
            if not sections or sections[-1]["year"] != year:
                sections.append({"year": year, "events": []})
            sections[-1]["events"].append({
                "id": event["id"],
                "start_day": event["start_day"],
                "end_day": event["end_day"],
                "title": event["title"],
                "summary": event["summary"],
                "tags": db.jload(event["tags"]),
                "photo_count": event["photo_count"],
                "photos": photos,
            })
    sections = [s for s in sections if s["events"]][-max_events:]
    stats = aggregate.compute_stats()
    stored = profile_mod.get_profile()
    return {
        "sections": sections,
        "summary": stored.get("summary_first_person") or stored.get("summary", ""),
        "summary_third_person": stored.get("summary", ""),
        "stats": {
            "span": stats["day_span"],
            "active_days": stats["active_days"],
            "described": stats["described"],
            "total_assets": stats["total_assets"],
            "coverage": stats["coverage"],
            "events": sum(len(s["events"]) for s in sections),
        },
        "generated_at": datetime.now().isoformat(timespec="seconds"),
    }
