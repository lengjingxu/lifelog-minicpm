"""人生叙事：先把"可讲的 facts"算出来，再让 MiniCPM 写成日记。

和 profile 的区别：
  profile  = 客观统计 + 概括
  story    = 把计数事实织进第二人称日记（今年第几次带孩子出门、比上年多还是少）
  insight  = 对这个人的拍摄偏好与性格的分析
"""
from __future__ import annotations

import re
from collections import Counter, defaultdict
from datetime import datetime, timezone

from . import config, db

KID_WORDS = ("小孩", "女孩", "婴儿", "儿童", "孩子", "宝宝")
SOLO_WORDS = ("一人", "独自")
OUTDOOR_TAGS = ("风景", "运动户外")
TRAVEL_TAGS = ("风景", "运动户外", "活动聚会")


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _is_kid(text: str) -> bool:
    return any(word in (text or "") for word in KID_WORDS)


def build_facts(since_day: str | None = None) -> dict:
    db.init_db()
    with db.session() as con:
        query = """SELECT a.id, a.day, a.taken_at, c.caption, c.scene, c.people, c.place,
                          c.activity, c.mood, c.tags
                   FROM assets a JOIN captions c ON c.asset_id = a.id
                   WHERE c.status='ok' AND c.prompt_version='describe-v1'"""
        params: list = []
        if since_day:
            query += " AND a.day >= ?"
            params.append(since_day)
        rows = con.execute(query, params).fetchall()

    days = Counter()
    day_kid = {}
    day_outdoor = {}
    day_people = defaultdict(Counter)
    mood = Counter()
    place = Counter()
    activity = Counter()
    scene = Counter()
    hour = Counter()
    by_year_days = Counter()
    by_year_kid_out = Counter()
    for row in rows:
        day = row["day"]
        if not day:
            continue
        year = day[:4]
        days[day] += 1
        by_year_days[year] += 1
        people = row["people"] or ""
        tags = db.jload(row["tags"])
        kid = _is_kid(people) or "儿童" in tags
        outdoor = any(t in tags for t in OUTDOOR_TAGS)
        if kid:
            day_kid[day] = day_kid.get(day, 0) + 1
        if outdoor:
            day_outdoor[day] = day_outdoor.get(day, 0) + 1
        if kid and outdoor:
            by_year_kid_out[year] += 1
        if any(w in people for w in SOLO_WORDS):
            day_people[day]["solo"] += 1
        else:
            day_people[day]["with"] += 1
        if row["mood"]:
            mood[row["mood"].split("/")[0]] += 1
        if row["place"] and row["place"] != "无":
            place[row["place"].split("/")[0]] += 1
        if row["activity"]:
            activity[row["activity"].split("/")[0]] += 1
        if row["scene"]:
            scene[row["scene"].split("/")[0]] += 1
        taken = row["taken_at"] or ""
        if len(taken) >= 13:
            hour[int(taken[11:13])] += 1

    outdoor_days = sorted(day_outdoor)
    kid_out_days = sorted(d for d in outdoor_days if d in day_kid)
    year_outdoor_days = Counter(d[:4] for d in outdoor_days)
    year_kid_days = Counter(d[:4] for d in kid_out_days)

    kid_out_index = {}
    per_year = Counter()
    for day in kid_out_days:
        year = day[:4]
        per_year[year] += 1
        kid_out_index[day] = per_year[year]

    solo = sum(c["solo"] for c in day_people.values())
    together = sum(c["with"] for c in day_people.values())

    years = sorted(year_outdoor_days)
    year_lines = []
    for year in years:
        year_lines.append(f"{year} 年：{year_outdoor_days[year]} 天在外面，"
                          f"其中 {year_kid_days.get(year, 0)} 天带着孩子")
    trend = ""
    if len(years) >= 2:
        first, last = years[0], years[-1]
        a = year_outdoor_days[first]
        b = year_outdoor_days[last]
        if b < a:
            trend = (f"最早的 {first} 年有 {a} 天的户外记录，最近的 {last} 年只有 {b} 天，"
                     f"出门明显少了")
        elif b > a:
            trend = (f"最近的 {last} 年有 {b} 天在外面，比 {first} 年的 {a} 天多，"
                     f"你比从前更爱往外走")
        else:
            trend = f"{first} 年和 {last} 年都在户外待了差不多 {a} 天"
    recent_kid = ""
    if kid_out_days:
        last = kid_out_days[-1]
        recent_kid = (f"最近一次带孩子出门是 {last}，那是你 {last[:4]} 年的第 "
                      f"{kid_out_index[last]} 次")
    busiest = days.most_common(3)
    peak_hours = [h for h, _ in hour.most_common(3)]
    return {
        "photos": len(rows),
        "active_days": len(days),
        "outdoor_days": len(outdoor_days),
        "kid_out_days": len(kid_out_days),
        "solo_photos": solo,
        "together_photos": together,
        "solo_ratio": round(solo / max(1, solo + together), 3),
        "year_lines": year_lines,
        "trend": trend,
        "recent_kid": recent_kid,
        "top_moods": mood.most_common(5),
        "top_places": place.most_common(5),
        "top_activities": activity.most_common(5),
        "top_scenes": scene.most_common(4),
        "busiest_days": busiest,
        "peak_hours": peak_hours,
        "first_day": min(days) if days else "",
        "last_day": max(days) if days else "",
    }


def render_facts(facts: dict) -> str:
    """可直接引用的数字白名单：模型只允许原样使用这里的数字。"""
    def fmt(items, limit=5):
        return "、".join(f"{k} {v} 张" for k, v in items[:limit]) or "无"

    lines = [
        "【可直接引用的数字（必须原样使用，不得自行换算或改写）】",
        f"照片总数 {facts['photos']} 张，出现在 {facts['active_days']} 天"
        f"（{facts['first_day']} 到 {facts['last_day']}）",
        f"其中有户外记录 {facts['outdoor_days']} 天，带着孩子的 {facts['kid_out_days']} 天",
    ]
    for line in facts["year_lines"]:
        lines.append(line)
    if facts["recent_kid"]:
        lines.append(facts["recent_kid"])
    lines += [
        f"只有你一个人的照片 {facts['solo_photos']} 张，有同行者的 {facts['together_photos']} 张，"
        f"独处占比 {facts['solo_ratio']:.0%}",
        f"最常拍照的时段：{'、'.join(str(h) + ' 点' for h in facts['peak_hours'])}",
        f"最常见的地点：{fmt(facts['top_places'])}",
        f"最常见的动作：{fmt(facts['top_activities'])}",
        f"最常见的场景：{fmt(facts['top_scenes'])}",
        f"情绪基调：{fmt(facts['top_moods'])}",
        "照片最多的日子：" + "、".join(f"{d}（{c} 张）" for d, c in facts["busiest_days"][:3]),
    ]
    if facts["trend"]:
        lines.append("变化：" + facts["trend"])
    lines.append("【清单结束】")
    return chr(10).join(lines)


STORY_PROMPT = (
    "你在替一个人写他相册的「人生回顾」。请用**第二人称**（对读者说「你」），"
    "写成一篇 6-9 段的中文日记式散文。\n"
    "硬性要求：\n"
    "1. 必须把下面「可直接引用的数字」里的数字织进文字里，"
    "数字、单位、序号都要**原样照抄**（例如清单写「2026 年第 1 次」就写「第 1 次」，"
    "绝不能自己推算或改写）；"
    "比如「这是你 2023 年第三次带孩子出门」「今年你只在户外待了 7 天，比 2024 年少了 12 天」"
    "「你拍得最多的时刻是下午 4 点」；不要只写感受，要有可验证的事实；\n"
    "2. 语气是朋友式的、贴人的：可以温柔、可以欣赏、也可以说一点真话"
    "（例如「今年你出门少了，是不是该多走走」），但不要煽情、不要写成鸡汤；\n"
    "3. 允许写你从事实里读出来的判断（例如「你大概更在意陪伴而不是打卡」），"
    "但必须能对应到清单里的某条事实，不许凭空捏造人名、地名、天气和具体事件；\n"
    "4. 只写正文，不要标题、不要列表、不要 Markdown 标记；"
    "不要在最后一段重复前面已经写过的事实；\n\n"
    "可直接引用的数字：\n{facts}"
)

VOICES = {
    "diary": {
        "title": "你的这些年",
        "kicker": "Recap",
        "label": "回顾",
        "prompt": (
            "你在替一个人写他相册的「人生回顾」。用**第二人称**（对读者说「你」），"
            "像朋友翻完这批照片后当面跟你说话。"
            "只能围绕下面「素材」里的瞬间展开，挑 2-3 个讲，**不要把素材罗列一遍**，"
            "也不要另找素材。"
            + chr(10) + chr(10)
            + "素材：" + chr(10) + "{beats}"
            + chr(10) + chr(10)
            + "可参考的画面细节（挑一两条用，不要罗列）：" + chr(10) + "{evidence}"
            + chr(10) + chr(10)
            + "这些数字只用于核对（不要逐条报出来）：" + chr(10) + "{facts}"
        ),
    },
    "future": {
        "title": "给十年后的你",
        "kicker": "In Ten Years",
        "label": "给十年后的你",
        "prompt": (
            "你要写一段文字，给**十年后的自己**看：以后翻这本相册的人，"
            "会想知道现在的自己是怎么活的。用**第二人称**，把「十年后的你」当作读者。"
            "只能围绕下面「素材」里的瞬间展开，挑 2-3 个讲，不要罗列。"
            "可以坦率，也可以留白；不要励志，不要教训人。"
            + chr(10) + chr(10)
            + "素材：" + chr(10) + "{beats}"
            + chr(10) + chr(10)
            + "可参考的画面细节（挑一两条用，不要罗列）：" + chr(10) + "{evidence}"
            + chr(10) + chr(10)
            + "这些数字只用于核对（不要逐条报出来）：" + chr(10) + "{facts}"
        ),
    },
    "family": {
        "title": "给家人的一封信",
        "kicker": "To Family",
        "label": "给家人的信",
        "prompt": (
            "你要写一封短信给家里人，收信人是那个陪你出门、带孩子的人。"
            "用**第一人称**（写信的人是你）。只围绕下面「素材」里的瞬间展开，"
            "挑 1-2 个讲，像随口交代一句近况。"
            "不要歌颂亲情，不要写称呼，不要抒情，结尾停在一件具体的小事上。"
            + chr(10) + chr(10)
            + "素材：" + chr(10) + "{beats}"
            + chr(10) + chr(10)
            + "可参考的画面细节（挑一两条用，不要罗列）：" + chr(10) + "{evidence}"
            + chr(10) + chr(10)
            + "这些数字只用于核对（不要逐条报出来）：" + chr(10) + "{facts}"
        ),
    },
}

COMMON_RULES = (
    "写作要求："
    "1. 开头不要报统计数字，先给一个画面；"
    "2. 不要罗列素材，不要逐条引用清单里的数字，数字最多出现两处，且要嵌在句子里；"
    "3. 短句为主，每句不超过二十来个字，一段 2-4 句；"
    "4. 克制：可以有情绪，但不煽情，不用「岁月静好」「时光温柔」「治愈」「释怀」这类词，"
    "不堆形容词；"
    "5. 不要在结尾升华或总结，不要写「这就是生活」这类收尾；"
    "6. 只写正文，不要标题、不要 Markdown、不要列表。"
    + chr(10) + chr(10)
)


INSIGHT_PROMPT = (
    "你在替一个人做一份「自我画像」，素材是他相册里被本地视觉模型逐张识别出的描述。"
    "请用中文**第二人称**（对读者说「你」）写 4 段，每段前面加一行小标题，"
    "小标题依次是：【你最爱拍什么】【你的性格底色】【你没拍下来的那部分】【给你的三条建议】。"
    + chr(10) + chr(10)
    + "硬性要求：" + chr(10)
    + "1. **必须用照片细节举证**：每一段至少引用两条具体证据——"
    "要么写清日期与画面里的东西（例：2024-01-01 那天 727 张里有 279 张在同一个湖边、"
    "背光的轮廓、水面上的光），要么给出可核对的数字（例：湖边 437 张只用了 6 天、"
    "带孩子的日子几乎都在周末）。先摆证据，再下判断；" + chr(10)
    + "2. **不许泛泛而谈**：禁止「热爱生活」「有艺术天赋」「热爱自然」这类没有出处的形容词，"
    "每个判断都要能追到上面的证据或照片描述；" + chr(10)
    + "3. 【你最爱拍什么】写题材偏好**和拍摄习惯**（时段、重复取景、一天怎么换地方）；" + chr(10)
    + "4. 【你的性格底色】从证据推出性格倾向（独处或外向、审美、情绪习惯），"
    "允许有观点，但每条都要点名证据；" + chr(10)
    + "5. 【你没拍下来的那部分】写他**几乎没有**记录过什么（例如从没出现过的题材），"
    "并解释这说明什么；不要把「只有少量记录」说成「从不记录」；" + chr(10)
    + "6. 【给你的三条建议】每条一句话，具体、可执行、基于证据；" + chr(10)
    + "7. 语气像懂摄影也懂人的朋友在聊天，可以有态度，不写标题以外的 Markdown 标记，"
    "全文不重复同一件事，不做总结升华。" + chr(10) + chr(10)
    + "证据清单：" + chr(10) + "{evidence}"
    + chr(10) + chr(10)
    + "可引用的数字：" + chr(10) + "{facts}"
)




def build_beats(since_day: str | None = None) -> list[dict]:
    """挑出几个具体瞬间当素材：模型围着画面写，而不是围着数字写。"""
    db.init_db()
    with db.session() as con:
        query = ("SELECT a.id, a.day, a.taken_at, c.caption, c.people, c.place, c.activity, c.tags "
                 "FROM assets a JOIN captions c ON c.asset_id = a.id "
                 "WHERE c.status='ok' AND c.prompt_version='describe-v1'")
        params: list = []
        if since_day:
            query += " AND a.day >= ?"
            params.append(since_day)
        rows = con.execute(query + " ORDER BY a.day, a.taken_at", params).fetchall()

    by_day: dict[str, list] = {}
    for row in rows:
        by_day.setdefault(row["day"], []).append(row)

    def kid_row(day_rows):
        for row in day_rows:
            people = row["people"] or ""
            tags = db.jload(row["tags"])
            if any(w in people for w in KID_WORDS) or "儿童" in tags:
                return row
        return None

    def outdoor_row(day_rows):
        for row in day_rows:
            if any(t in db.jload(row["tags"]) for t in OUTDOOR_TAGS):
                return row
        return None

    beats: list[dict] = []
    if by_day:
        busiest = max(by_day.items(), key=lambda kv: len(kv[1]))
        row = outdoor_row(busiest[1]) or busiest[1][0]
        beats.append({"kind": "最密集的一天",
                      "text": f"{busiest[0]} 这一天你拍了 {len(busiest[1])} 张。"
                              f"其中一张写着：{row['caption']}"})
        kid_days = [d for d in sorted(by_day) if kid_row(by_day[d])]
        if kid_days:
            last = kid_days[-1]
            row = kid_row(by_day[last])
            beats.append({"kind": "最近一次带孩子出门",
                          "text": f"{last}，{row['caption']}"})
            first = kid_days[0]
            row = kid_row(by_day[first])
            beats.append({"kind": "最早一次带孩子出门",
                          "text": f"{first}，{row['caption']}"})
        outdoor_days = [d for d in sorted(by_day) if outdoor_row(by_day[d])]
        if outdoor_days:
            mid = outdoor_days[len(outdoor_days) // 2]
            row = outdoor_row(by_day[mid])
            beats.append({"kind": "一个普通的外出日",
                          "text": f"{mid}，{row['caption']}"})
        late = [r for r in rows if (r["taken_at"] or "")[11:13] == "16"]
        if late:
            row = late[len(late) // 3]
            beats.append({"kind": "下午四点的光线",
                          "text": f"{row['day']} {row['taken_at'][11:16]}，{row['caption']}"})
    return beats


def render_beats(beats: list[dict]) -> str:
    return chr(10).join(f"- 【{b['kind']}】{b['text']}" for b in beats)
LIGHT_WORDS = ("阳光", "逆光", "夕阳", "黄昏", "日落", "晨光", "柔光", "暖光", "光影",
               "阴天", "雾", "雪", "晴朗", "云")
SUBJECT_WORDS = ("背影", "手", "水面", "湖面", "山", "剪影", "微笑", "孩子", "女孩", "婴儿",
                 "窗户", "桌", "花", "树", "路", "车", "衣服", "围巾", "气球", "灯笼")
WEEKDAY_CN = ("周一", "周二", "周三", "周四", "周五", "周六", "周日")


def _pick_detail(row) -> str:
    parts = []
    if row["place"] and row["place"] != "无":
        parts.append(str(row["place"]).split("/")[0])
    if row["activity"]:
        parts.append(str(row["activity"]).split("/")[0])
    if row["people"] and row["people"] != "无":
        parts.append(str(row["people"]).split("/")[0])
    return "·".join(parts)


def build_evidence(since_day: str | None = None) -> dict:
    """从逐张描述里抽"可举证的细节"：光线、构图、重复取景、拍摄节奏、同行结构。"""
    db.init_db()
    with db.session() as con:
        query = ("SELECT a.id, a.day, a.taken_at, c.caption, c.people, c.place, c.activity, c.tags "
                 "FROM assets a JOIN captions c ON c.asset_id = a.id "
                 "WHERE c.status='ok' AND c.prompt_version='describe-v1'")
        params: list = []
        if since_day:
            query += " AND a.day >= ?"
            params.append(since_day)
        rows = con.execute(query + " ORDER BY a.day, a.taken_at", params).fetchall()

    by_day: dict[str, list] = {}
    for row in rows:
        by_day.setdefault(row["day"], []).append(row)

    light = Counter()
    subject = Counter()
    hour = Counter()
    place_days: dict[str, set] = {}
    place_photos = Counter()
    weekday_kid = Counter()
    weekday_all = Counter()
    scenes_per_day = []
    samples: list[dict] = []

    for row in rows:
        caption = row["caption"] or ""
        for word in LIGHT_WORDS:
            if word in caption:
                light[word] += 1
        for word in SUBJECT_WORDS:
            if word in caption:
                subject[word] += 1
        taken = row["taken_at"] or ""
        if len(taken) >= 13:
            hour[int(taken[11:13])] += 1
        place = (row["place"] or "").split("/")[0]
        if place and place != "无":
            place_days.setdefault(place, set()).add(row["day"])
            place_photos[place] += 1
        day = row["day"]
        try:
            weekday = WEEKDAY_CN[datetime.fromisoformat(day).weekday()]
        except Exception:
            weekday = ""
        if weekday:
            weekday_all[weekday] += 1
            if any(w in (row["people"] or "") for w in KID_WORDS):
                weekday_kid[weekday] += 1

    for day, day_rows in by_day.items():
        places = {(r["place"] or "").split("/")[0] for r in day_rows}
        places.discard("")
        places.discard("无")
        scenes_per_day.append(len(places))

    # 挑 4 条带光线或主体细节、且互相不同的样例
    picked: list[dict] = []
    seen_year = set()
    for row in rows:
        caption = row["caption"] or ""
        if len(caption) < 16:
            continue
        if not any(w in caption for w in LIGHT_WORDS + SUBJECT_WORDS):
            continue
        year = (row["day"] or "")[:4]
        key = (year, (row["place"] or "")[:3])
        if key in seen_year:
            continue
        seen_year.add(key)
        picked.append({"id": row["id"], "day": row["day"], "time": taken_time(row),
                       "caption": caption, "detail": _pick_detail(row)})
        if len(picked) >= 5:
            break
    samples = picked

    top_places = sorted(((name, len(days), place_photos.get(name, 0))
                          for name, days in place_days.items()),
                         key=lambda item: -item[2])[:6]
    busiest_day = max(by_day.items(), key=lambda kv: len(kv[1])) if by_day else ("", [])
    same_place = 0
    if busiest_day:
        place_counter = Counter()
        for r in busiest_day[1]:
            p = (r["place"] or "").split("/")[0]
            if p and p != "无":
                place_counter[p] += 1
        same_place = place_counter.most_common(1)[0][1] if place_counter else 0

    return {
        "light": light.most_common(6),
        "subject": subject.most_common(8),
        "hours": hour.most_common(6),
        "top_places": top_places,
        "busiest_day": busiest_day[0],
        "busiest_day_count": len(busiest_day[1]),
        "busiest_day_same_place": same_place,
        "avg_scenes_per_day": round(sum(scenes_per_day) / max(1, len(scenes_per_day)), 1),
        "weekday_kid": weekday_kid.most_common(3),
        "weekday_all": weekday_all.most_common(3),
        "samples": samples,
    }


def taken_time(row) -> str:
    taken = row["taken_at"] or ""
    return taken[11:16] if len(taken) >= 16 else ""


def render_evidence(ev: dict) -> str:
    def fmt(items, limit=6):
        return "、".join(f"{k}（{v}）" for k, v in items[:limit]) or "无"

    lines = [
        "【光线】" + fmt(ev["light"]),
        "【画面里反复出现的元素】" + fmt(ev["subject"]),
        "【拍摄时段】" + "、".join(f"{h} 点（{c} 张）" for h, c in ev["hours"]),
        "【反复去的地方】"
        + "、".join(f"{name}（{photos} 张 / {days} 天）" for name, days, photos in ev["top_places"]),
        f"【最猛的一天】{ev['busiest_day']} 拍了 {ev['busiest_day_count']} 张，"
        f"其中 {ev['busiest_day_same_place']} 张在同一个地方",
        f"【一天里换几个地方】平均 {ev['avg_scenes_per_day']} 处",
        "【带孩子的日子多在周几】" + ("、".join(f"{d}（{c} 张）" for d, c in ev["weekday_kid"]) or "无"),
    ]
    if ev["samples"]:
        lines.append("【几张具体照片的原始描述】")
        for s in ev["samples"]:
            lines.append(f"- {s['day']} {s['time']}｜{s['detail']}｜{s['caption']}")
    return chr(10).join(lines)


def _store(con, key: str, value: str) -> None:
    con.execute(
        """INSERT INTO profile (key, value, evidence, updated_at) VALUES (?,?,?,?)
           ON CONFLICT(key) DO UPDATE SET value=excluded.value,
             evidence=excluded.evidence, updated_at=excluded.updated_at""",
        (key, value, 0, now_iso()),
    )


def generate_story(model_key: str = "minicpm-v-4.5-8b", since_day: str | None = None,
                   voice: str = "diary", all_voices: bool = False) -> dict:
    """把素材写成指定视角的叙事（默认回顾；all_voices=True 一次生成三种）。"""
    from . import models

    since = since_day if since_day is not None else config.REVIEW_SINCE_DAY
    facts = render_facts(build_facts(since))
    beats = render_beats(build_beats(since))
    evidence = render_evidence(build_evidence(since))
    targets = list(VOICES) if all_voices else [voice]
    out_map = {}
    with models.Server(model_key) as server:
        for key in targets:
            spec = VOICES[key]
            prompt = spec["prompt"] + COMMON_RULES
            out = server.chat(prompt.format(beats=beats, facts=facts, evidence=evidence),
                              max_tokens=1100, temperature=0.55, timeout=600).strip()
            out_map[key] = out
            with db.session() as con:
                _store(con, f"story_{key}", out)
            if key == "diary":
                with db.session() as con:
                    _store(con, "story", out)
    return out_map


def generate_insight(model_key: str = "minicpm-v-4.5-8b", since_day: str | None = None) -> str:
    """基于照片细节做一份拍摄偏好与性格分析。"""
    from . import models

    since = since_day if since_day is not None else config.REVIEW_SINCE_DAY
    facts = render_facts(build_facts(since))
    evidence = render_evidence(build_evidence(since))
    with models.Server(model_key) as server:
        out = server.chat(INSIGHT_PROMPT.format(evidence=evidence, facts=facts),
                          max_tokens=1600, temperature=0.5, timeout=600).strip()
    with db.session() as con:
        _store(con, "insight", out)
    return out


def get(key: str) -> str:
    db.init_db()
    with db.session() as con:
        row = con.execute("SELECT value FROM profile WHERE key=?", (key,)).fetchone()
    return row["value"] if row else ""
