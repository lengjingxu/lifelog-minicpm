#!/usr/bin/env python3
"""把多个模型的描述合并成一张 merged_caption 表。

规则（宁可少补，不能污染核心数字）：
  · 描述正文：以 MiniCPM 为主；MiniCPM 缺失时才用 Qwen。
  · 另一模型的正文存进 caption_alt，检索时一起搜。
  · scene / people / place / mood：只取主模型——这些字段直接影响
    「独处占比」「场景分布」等结论，混入二手判断风险太高。
  · activity：主模型为空时用副模型补（观察 Qwen 这一列是可靠的）。
  · tags：两边的标签都归一到 config.TAG_TAXONOMY 的主类再取并集；
    但「人物」只认主模型的 people 字段，避免 Qwen 把空景误标成人物。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lifelog import config, db  # noqa: E402

PRIMARY = "minicpm-v-4.7-1b"
SECONDARY = "qwen3-vl-2b"

PERSON_WORDS = ("人", "男", "女", "孩", "儿童", "婴儿", "宝宝", "老人", "情侣",
                "朋友", "家人", "合影", "人群")

SCHEMA = """
DROP TABLE IF EXISTS merged_caption;
CREATE TABLE merged_caption (
    asset_id TEXT PRIMARY KEY,
    caption TEXT,
    caption_alt TEXT,
    scene TEXT,
    people TEXT,
    place TEXT,
    activity TEXT,
    mood TEXT,
    tags TEXT,
    sources TEXT,
    merged_at TEXT,
    status TEXT DEFAULT 'ok',
    prompt_version TEXT DEFAULT 'describe-v1',
    model TEXT DEFAULT 'merged',
    ocr_text TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_merged_tags ON merged_caption(tags);
"""


def load(con, model):
    rows = con.execute(
        "SELECT asset_id, caption, scene, people, place, activity, mood, tags "
        "FROM captions WHERE model = ? AND status = 'ok'", (model,)
    ).fetchall()
    return {row["asset_id"]: dict(row) for row in rows}


def parse_tags(raw):
    try:
        value = json.loads(raw or "[]")
        return value if isinstance(value, list) else []
    except ValueError:
        return []


def merge_tags(primary_tags, secondary_tags, primary_people):
    """主类并集；「人物」只认主模型的 people 字段。"""
    merged = list(config.canonical_tags(primary_tags))
    people_is_real = any(word in (primary_people or "") for word in PERSON_WORDS)
    for tag in config.canonical_tags(secondary_tags):
        if tag == "人物" and not people_is_real:
            continue
        if tag not in merged:
            merged.append(tag)
    order = {name: i for i, name in enumerate(config.TAXONOMY_ORDER)}
    return sorted(merged, key=lambda t: order.get(t, 99))


def main() -> int:
    db.init_db()
    with db.session() as con:
        con.executescript(SCHEMA)
        primary = load(con, PRIMARY)
        secondary = load(con, SECONDARY)
        cutoff = __import__("datetime").datetime.now().astimezone().isoformat(timespec="seconds")

        merged = 0
        from_primary = 0
        from_secondary = 0
        union_tags = 0
        filled_activity = 0
        for asset_id in sorted(set(primary) | set(secondary)):
            a = primary.get(asset_id) or {}
            b = secondary.get(asset_id) or {}
            if a:
                base, alt, sources = a, b, PRIMARY
                from_primary += 1
                if b:
                    sources += "+" + SECONDARY
            else:
                base, alt, sources = b, {}, SECONDARY
                from_secondary += 1

            tags = merge_tags(parse_tags(base.get("tags")),
                              parse_tags(alt.get("tags")),
                              base.get("people"))
            if len(tags) > len(config.canonical_tags(parse_tags(base.get("tags")))):
                union_tags += 1

            activity = base.get("activity") or alt.get("activity") or ""
            if not base.get("activity") and alt.get("activity"):
                filled_activity += 1

            con.execute(
                """INSERT INTO merged_caption
                   (asset_id, caption, caption_alt, scene, people, place, activity,
                    mood, tags, sources, merged_at, status, prompt_version, model, ocr_text)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,'ok','describe-v1','merged','')""",
                (asset_id, base.get("caption") or "", alt.get("caption") or "",
                 base.get("scene") or "", base.get("people") or "",
                 base.get("place") or "", activity, base.get("mood") or "",
                 json.dumps(tags, ensure_ascii=False), sources, cutoff),
            )
            merged += 1

        con.execute("DROP VIEW IF EXISTS current_caption")
        con.execute("CREATE VIEW current_caption AS SELECT * FROM merged_caption")

    print(json.dumps({
        "merged": merged,
        "primary_rows": from_primary,
        "secondary_only_rows": from_secondary,
        "tags_enriched": union_tags,
        "activity_filled_from_secondary": filled_activity,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
