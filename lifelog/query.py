"""检索与问答：让任意 AI 用自然语言查「这个人最近的生活」。"""
from __future__ import annotations

import re
from datetime import datetime, timezone

from . import db, models

STOPWORDS = ("的", "了", "我", "是", "在", "有", "和", "与", "最近", "什么", "怎么", "哪些", "吗", "呢",
             "通常", "一般", "平时", "常常", "经常", "主要", "哪里", "什么样", "请问", "帮我",
             "告诉我", "知道", "关于", "有没有", "是不是", "都在", "做些什么", "做什么", "什么时",
             "多少", "哪些", "关于我")


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def is_cjk(char: str) -> bool:
    code = ord(char)
    return 0x4E00 <= code <= 0x9FFF or 0x3400 <= code <= 0x4DBF


def clean(question: str) -> str:
    text = "".join(char for char in question if is_cjk(char))
    for word in STOPWORDS:
        text = text.replace(word, "")
    return text


def keywords(question: str) -> list[str]:
    """中文不做分词依赖：二字组合切分，兼顾召回与精度。"""
    text = clean(question)
    if not text:
        return [question.strip()]
    grams = [text[i:i + 2] for i in range(len(text) - 1)]
    return grams or [question.strip()]


def date_filter(question: str) -> tuple[str | None, str | None]:
    """从自然语言里认出年份/年月，自动限定检索区间。"""
    import calendar

    match = re.search(r"(20\d{2})\s*年\s*(\d{1,2})?\s*月?", question)
    if not match:
        return None, None
    year = int(match.group(1))
    month = int(match.group(2)) if match.group(2) else None
    if month:
        last = calendar.monthrange(year, month)[1]
        return f"{year:04d}-{month:02d}-01", f"{year:04d}-{month:02d}-{last:02d}"
    return f"{year:04d}-01-01", f"{year:04d}-12-31"


def search(question: str, since_day: str | None = None, until_day: str | None = None,
           limit: int = 12, auto_date: bool = True) -> list[dict]:
    """关键词打分检索。"""
    db.init_db()
    if auto_date:
        auto_since, auto_until = date_filter(question)
        since_day = since_day or auto_since
        until_day = until_day or auto_until
    keys = keywords(question)
    with db.session() as con:
        query = """SELECT a.id, a.day, a.taken_at, a.path, c.caption, c.scene, c.people,
                          c.place, c.activity, c.mood, c.tags, c.ocr_text
                   FROM assets a JOIN captions c ON c.asset_id = a.id
                   WHERE c.status = 'ok' AND c.prompt_version = 'describe-v1'"""
        params: list = []
        if since_day:
            query += " AND a.day >= ?"
            params.append(since_day)
        if until_day:
            query += " AND a.day <= ?"
            params.append(until_day)
        rows = con.execute(query, params).fetchall()

    scored = []
    for row in rows:
        haystack = " ".join(str(row[k] or "") for k in
                            ("caption", "scene", "people", "place", "activity", "mood", "tags", "ocr_text"))
        score = sum(haystack.count(key) for key in keys)
        if score == 0:
            continue
        tags = db.jload(row["tags"])
        for key in keys:
            if key in tags:
                score += 3
        scored.append((score, dict(row)))
    scored.sort(key=lambda item: (-item[0], item[1]["day"] or ""))
    return [row for _score, row in scored[:limit]]


def evidence_block(rows: list[dict]) -> str:
    lines = []
    for row in rows:
        parts = [f"- {row['day']}"]
        for key in ("activity", "place", "people"):
            value = row.get(key)
            if value and value != "无":
                parts.append(value)
        if row.get("caption"):
            parts.append(row["caption"])
        lines.append(" ".join(str(p) for p in parts if p))
    return "\n".join(lines)


STATS_HINTS = ("多少", "几张", "多少张", "多少天", "几天", "总数", "数量", "覆盖率", "规模",
               "多长时间", "多久", "占比", "统计", "一共", "总共")
BROAD_HINTS = ("一般", "通常", "整体", "总体", "平时", "习惯", "规律", "生活")


NL = chr(10)


def is_stat_question(question: str) -> bool:
    return any(hint in question for hint in STATS_HINTS)


def is_broad_question(question: str) -> bool:
    return any(hint in question for hint in BROAD_HINTS)


def stats_context() -> str:
    """客观统计：数字由数据库直接算出，不允许模型从证据条数推断。"""
    from . import aggregate, profile as profile_mod

    stored = profile_mod.get_profile().get("stats")
    if stored:
        return stored
    return aggregate.stats_to_text(aggregate.compute_stats())


def ask(question: str, model_key: str = "minicpm-v-4.7-1b", top_k: int = 12,
        use_profile: bool = True) -> dict:
    """检索证据 → 交给本地 MiniCPM 写答案。"""
    want_stats = is_stat_question(question)
    if is_broad_question(question):
        top_k = max(top_k, 24)
    rows = search(question, limit=top_k)
    if not rows:
        rows = search(question, limit=top_k, auto_date=False)
    profile_text = ""
    if use_profile:
        from . import profile as profile_mod
        summary = profile_mod.get_profile().get("summary")
        if summary:
            profile_text = summary
    context = []
    if profile_text:
        context.append("【已有生活画像】" + NL + profile_text)
    if want_stats:
        context.append("【客观统计（由数据库直接算出）】" + NL + stats_context())
    if rows:
        context.append("【相册中检索到的相关记录】" + NL + evidence_block(rows))
    if not context:
        return {"answer": "相册里还没有可用的记录，先跑 lifelog caption 生成描述。", "evidence": []}
    rules = ["你是一个只根据用户私人相册记录回答问题的助手。",
             "请只依据下面的记录回答用户问题，用中文，语气自然，可以提到具体日期和场景；",
             "如果记录不足以回答，就直接说记录里看不到相关线索，不要猜测。"]
    if want_stats:
        rules.append("问题涉及数量时，数字一律取自【客观统计】里的数值，"
                     "严禁把下面列出的记录条数当成总数。")
    prompt = NL.join(rules) + NL + NL + (NL + NL).join(context) + NL + NL + f"问题：{question}"
    with models.Server(model_key) as server:
        answer = server.chat(prompt, max_tokens=700, temperature=0.3, timeout=600)
    return {"answer": answer, "evidence": rows, "stats_used": want_stats}
