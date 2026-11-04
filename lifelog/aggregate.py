"""聚合：按天/事件/主题统计，产出结构化生活档案。"""
from __future__ import annotations

from collections import Counter
from datetime import datetime, timezone

from . import config, db


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _caption_rows(con, since_day=None, until_day=None, model=None):
    query = """SELECT a.id, a.day, a.taken_at, a.path, c.caption, c.scene, c.people,
                      c.place, c.activity, c.mood, c.tags
               FROM assets a JOIN captions c ON c.asset_id = a.id
               WHERE c.status = 'ok'"""
    params: list = []
    if since_day:
        query += " AND a.day >= ?"
        params.append(since_day)
    if until_day:
        query += " AND a.day <= ?"
        params.append(until_day)
    if model:
        query += " AND c.model = ?"
        params.append(model)
    query += " ORDER BY a.day, a.taken_at"
    return con.execute(query, params).fetchall()


def build_days(model: str | None = None) -> int:
    """把逐张描述聚合成「一天的样子」。"""
    db.init_db()
    with db.session() as con:
        rows = _caption_rows(con, model=model)
        photos = {r["day"]: r["day"] for r in con.execute("SELECT day FROM assets WHERE day IS NOT NULL")}
        buckets: dict[str, dict] = {}
        for day in photos:
            buckets[day] = {"tags": Counter(), "hours": Counter(), "described": 0}
        for row in rows:
            day = row["day"]
            if day not in buckets:
                continue
            buckets[day]["described"] += 1
            for tag in db.jload(row["tags"]):
                buckets[day]["tags"][tag] += 1
            taken = row["taken_at"] or ""
            if len(taken) >= 13:
                buckets[day]["hours"][int(taken[11:13])] += 1
        for day, bucket in buckets.items():
            con.execute(
                """INSERT INTO days (day, photo_count, described, tags, hour_histogram, updated_at)
                   VALUES (?,?,?,?,?,?)
                   ON CONFLICT(day) DO UPDATE SET
                     photo_count=excluded.photo_count, described=excluded.described,
                     tags=excluded.tags, hour_histogram=excluded.hour_histogram,
                     updated_at=excluded.updated_at""",
                (day, len([1 for d in photos if d == day]), bucket["described"],
                 db.jdump(bucket["tags"].most_common(6)),
                 db.jdump({str(h): c for h, c in sorted(bucket["hours"].items())}),
                 now_iso()),
            )
        return len(buckets)


def build_events(gap_days: int = 1, min_photos: int = 3, model: str | None = None) -> int:
    """把连续有照片的日子串成「一段生活片段」。"""
    from datetime import date, timedelta

    db.init_db()
    with db.session() as con:
        rows = con.execute(
            """SELECT a.day, COUNT(*) AS n FROM assets a
               JOIN captions c ON c.asset_id = a.id
               WHERE c.status='ok' AND a.day IS NOT NULL
               GROUP BY a.day ORDER BY a.day"""
        ).fetchall()
        if not rows:
            return 0
        counts = {r["day"]: r["n"] for r in rows}
        days = sorted(counts)
        segments: list[list[str]] = []
        current = [days[0]]
        for day in days[1:]:
            prev = date.fromisoformat(current[-1])
            cur = date.fromisoformat(day)
            if (cur - prev).days <= gap_days + 1:
                current.append(day)
            else:
                segments.append(current)
                current = [day]
        segments.append(current)

        con.execute("DELETE FROM events")
        created = 0
        for segment in segments:
            photos = sum(counts[d] for d in segment)
            if photos < min_photos:
                continue
            tags = Counter()
            summary_bits = []
            for day in segment:
                for row in con.execute(
                    """SELECT c.caption, c.tags FROM captions c JOIN assets a ON a.id=c.asset_id
                       WHERE a.day = ? AND c.status='ok' LIMIT 6""", (day,)
                ):
                    for tag in db.jload(row["tags"]):
                        tags[tag] += 1
                    if row["caption"]:
                        summary_bits.append(row["caption"])
            top_tags = [t for t, _ in tags.most_common(4)]
            generic = {"人物", "风景"}
            specific = [t for t in top_tags if t not in generic]
            activity_head = ""
            for row in con.execute(
                """SELECT c.activity FROM captions c JOIN assets a ON a.id=c.asset_id
                   WHERE a.day = ? AND c.status='ok' AND c.activity IS NOT NULL
                     AND c.activity != '' LIMIT 20""", (day,)
            ):
                head = str(row["activity"]).split("/")[0].strip()
                if head:
                    activity_head = head
                    break
            if specific:
                title = "、".join(specific[:2])
            elif activity_head:
                title = f"{top_tags[0]}｜{activity_head}" if top_tags else activity_head
            else:
                title = "、".join(top_tags[:2]) or segment[0]
            summary = "；".join(summary_bits[:6])
            con.execute(
                """INSERT INTO events (start_day, end_day, title, summary, tags, photo_count,
                                       model, created_at)
                   VALUES (?,?,?,?,?,?,?,?)""",
                (segment[0], segment[-1], title, summary, db.jdump(top_tags), photos, model, now_iso()),
            )
            created += 1
        return created


def compute_stats(model: str | None = None, since_day=None, until_day=None) -> dict:
    """生活画像的统计底稿（不依赖模型）。"""
    db.init_db()
    with db.session() as con:
        rows = _caption_rows(con, since_day, until_day, model)
        tags = Counter()
        scenes = Counter()
        people = Counter()
        places = Counter()
        activities = Counter()
        moods = Counter()
        hours = Counter()
        months = Counter()
        days = Counter()
        for row in rows:
            for tag in db.jload(row["tags"]):
                tags[tag] += 1
            for field, counter in (("scene", scenes), ("people", people),
                                   ("place", places), ("activity", activities), ("mood", moods)):
                value = row[field]
                if value and value not in {"无", "未知"}:
                    counter[value] += 1
            taken = row["taken_at"] or ""
            if len(taken) >= 13:
                hours[int(taken[11:13])] += 1
            if row["day"]:
                months[row["day"][:7]] += 1
                days[row["day"]] += 1
        total_assets = con.execute("SELECT COUNT(*) FROM assets WHERE kind='image'").fetchone()[0]
    return {
        "described": len(rows),
        "total_assets": total_assets,
        "coverage": round(len(rows) / total_assets, 4) if total_assets else 0.0,
        "day_span": [min(days), max(days)] if days else [],
        "active_days": len(days),
        "top_tags": tags.most_common(12),
        "top_scenes": scenes.most_common(8),
        "top_people": people.most_common(6),
        "top_places": places.most_common(8),
        "top_activities": activities.most_common(10),
        "top_moods": moods.most_common(6),
        "hour_histogram": {str(h): hours[h] for h in range(24) if hours[h]},
        "monthly": dict(sorted(months.items())),
        "busiest_days": days.most_common(8),
    }


def stats_to_text(stats: dict) -> str:
    def fmt(items, limit=10):
        return "、".join(f"{k}({v})" for k, v in items[:limit]) or "无"

    hours = stats.get("hour_histogram", {})
    peak = sorted(hours.items(), key=lambda kv: -kv[1])[:4]
    lines = [
        f"已识别照片 {stats['described']} 张（总资产 {stats['total_assets']} 张，覆盖率 {stats['coverage']:.1%}）",
        f"时间跨度 {stats['day_span'][0]} ~ {stats['day_span'][1]}，活跃 {stats['active_days']} 天" if stats["day_span"] else "暂无时间跨度",
        f"高频标签：{fmt(stats['top_tags'])}",
        f"常见场景：{fmt(stats['top_scenes'])}",
        f"人物构成：{fmt(stats['top_people'])}",
        f"地点线索：{fmt(stats['top_places'])}",
        f"主要活动：{fmt(stats['top_activities'])}",
        f"氛围：{fmt(stats['top_moods'])}",
        f"拍摄高峰时段：{fmt([(f'{h}点', c) for h, c in peak])}",
        f"照片最多的日子：{fmt([(d, c) for d, c in stats['busiest_days']])}",
    ]
    return "\n".join(lines)
