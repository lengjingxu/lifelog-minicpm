"""检索与问答：让任意 AI 用自然语言查「这个人最近的生活」。"""
from __future__ import annotations

from datetime import datetime, timezone

from . import db, models

STOPWORDS = {"的", "了", "我", "是", "在", "有", "和", "与", "最近", "什么", "怎么", "哪些", "吗", "呢"}


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _keywords(question: str) -> list[str]:
    parts = [p for p in question.replace("，", " ").replace("。", " ").split() if p]
    keys = [p for p in parts if len(p) >= 2 and p not in STOPWORDS]
    return keys or [question.strip()]


def search(question: str, since_day: str | None = None, until_day: str | None = None,
           limit: int = 12) -> list[dict]:
    """关键词打分检索（中文按子串匹配，避免分词依赖）。"""
    db.init_db()
    keys = _keywords(question)
    with db.session() as con:
        query = """SELECT a.id, a.day, a.taken_at, a.path, c.caption, c.scene, c.people,
                          c.place, c.activity, c.mood, c.tags
                   FROM assets a JOIN captions c ON c.asset_id = a.id
                   WHERE c.status='ok'"""
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
        haystack = " ".join(str(row[k] or "") for k in ("caption", "scene", "people", "place", "activity", "mood", "tags"))
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
        if row.get("activity"):
            parts.append(row["activity"])
        if row.get("place") and row["place"] != "无":
            parts.append(row["place"])
        if row.get("people"):
            parts.append(row["people"])
        parts.append(row.get("caption") or "")
        lines.append(" ".join(str(p) for p in parts if p))
    return "\n".join(lines)


def ask(question: str, model_key: str = "minicpm-v-4.7-1b", top_k: int = 12,
        use_profile: bool = True) -> dict:
    """检索证据 → 交给本地 MiniCPM 写答案。"""
    rows = search(question, limit=top_k)
    profile_text = ""
    if use_profile:
        from . import profile as profile_mod
        stored = profile_mod.get_profile()
        summary = stored.get("summary")
        if summary:
            profile_text = summary
    context = []
    if profile_text:
        context.append("【已有生活画像】\n" + profile_text)
    if rows:
        context.append("【相册中检索到的相关记录】\n" + evidence_block(rows))
    if not context:
        return {"answer": "相册里还没有可用的记录，先跑 lifelog caption 生成描述。", "evidence": []}
    prompt = (
        "你是一个只根据用户私人相册记录回答问题的助手。"
        "请只依据下面的记录回答用户问题，用中文，语气自然，可以提到具体日期和场景；"
        "如果记录不足以回答，就直接说记录里看不到相关线索。\n\n"
        + "\n\n".join(context)
        + f"\n\n问题：{question}"
    )
    with models.Server(model_key) as server:
        answer = server.chat(prompt, max_tokens=700, temperature=0.3, timeout=600)
    return {"answer": answer, "evidence": rows}
