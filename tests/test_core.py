"""核心逻辑单测：不依赖模型、不依赖真实相册。"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lifelog import caption, config, db, query  # noqa: E402


class RelativeDateTests(unittest.TestCase):
    """相对时间解析：now 固定为 2026-11-07（周六）。"""

    NOW = query.datetime(2026, 11, 7)

    def df(self, text):
        return query.date_filter(text, now=self.NOW)

    def test_absolute_unchanged(self):
        self.assertEqual(self.df("2023年12月那趟旅行"), ("2023-12-01", "2023-12-31"))
        self.assertEqual(self.df("2024年"), ("2024-01-01", "2024-12-31"))

    def test_no_time(self):
        self.assertEqual(self.df("我一个人待着的时候在做什么"), (None, None))

    def test_year_words(self):
        self.assertEqual(self.df("今年的照片"), ("2026-01-01", "2026-12-31"))
        self.assertEqual(self.df("去年常去哪"), ("2025-01-01", "2025-12-31"))
        self.assertEqual(self.df("前年的夏天"), ("2024-06-01", "2024-08-31"))

    def test_month_words(self):
        self.assertEqual(self.df("上个月拍了什么"), ("2026-10-01", "2026-10-31"))
        self.assertEqual(self.df("这个月都干了啥"), ("2026-11-01", "2026-11-30"))

    def test_recent_ranges(self):
        self.assertEqual(self.df("最近7天"), ("2026-11-01", "2026-11-07"))
        self.assertEqual(self.df("近三个月"), ("2026-09-01", "2026-11-30"))
        self.assertEqual(self.df("过去2周"), ("2026-10-26", "2026-11-07"))

    def test_week_words(self):
        self.assertEqual(self.df("上周"), ("2026-10-26", "2026-11-01"))
        self.assertEqual(self.df("本周"), ("2026-11-02", "2026-11-08"))

    def test_season(self):
        self.assertEqual(self.df("去年冬天去哪了"), ("2025-12-01", "2026-02-28"))
        self.assertEqual(self.df("2024年秋天"), ("2024-09-01", "2024-11-30"))
        self.assertEqual(self.df("今年夏天"), ("2026-06-01", "2026-08-31"))


class TagTaxonomyTests(unittest.TestCase):
    def test_maps_free_form_tags_to_categories(self):
        self.assertEqual(config.canonical_tags(["户外", "山野"]), ["风景"])
        self.assertEqual(config.canonical_tags(["家具"]), ["室内居家"])
        self.assertEqual(config.canonical_tags(["二维码"]), ["文档票据"])

    def test_dedupes_and_orders(self):
        tags = config.canonical_tags(["风景", "人物", "户外", "人物"])
        self.assertEqual(tags, ["人物", "风景"])

    def test_unknown_tags_are_dropped(self):
        self.assertEqual(config.canonical_tags(["完全不存在的词"]), [])

    def test_handles_empty_and_none(self):
        self.assertEqual(config.canonical_tags(None), [])
        self.assertEqual(config.canonical_tags([]), [])


class CaptionParseTests(unittest.TestCase):
    def test_plain_json(self):
        data = caption.parse_json_object('{"caption":"a","tags":["风景"]}')
        self.assertEqual(data["caption"], "a")

    def test_missing_comma_is_repaired(self):
        raw = '{"caption":"a","mood":"宁静" "tags":["室内居家"]}'

        data = caption.parse_json_object(raw)
        self.assertIsNotNone(data)
        self.assertEqual(data["caption"], "a")
        self.assertEqual(data["mood"], "宁静")

    def test_field_fallback_when_json_is_broken(self):
        raw = '{"caption":"一张桌子","scene":"室内居家", "tags":["室内居家"'
        data = caption.parse_json_object(raw)
        self.assertEqual(data["caption"], "一张桌子")

    def test_returns_none_without_json(self):
        self.assertIsNone(caption.parse_json_object("这里没有 JSON"))
        self.assertIsNone(caption.parse_json_object(""))

    def test_surrounding_text_is_tolerated(self):
        data = caption.parse_json_object('好的 {"caption":"c"} 结束')
        self.assertEqual(data["caption"], "c")


class CleanTagsTests(unittest.TestCase):
    def test_keeps_only_known_categories(self):
        self.assertEqual(caption.clean_tags(["风景", "Cat"]), ["风景"])

    def test_caps_at_three(self):
        tags = caption.clean_tags(["人物", "风景", "室内居家", "美食"])
        self.assertEqual(len(tags), 3)


class MergeRuleTests(unittest.TestCase):
    """合并规则：核心字段只认主模型，标签才取并集。"""

    def test_person_tag_requires_primary_people(self):
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
        import merge_captions as m

        tags = m.merge_tags(["风景"], ["人物", "风景"], primary_people="无明确主体")
        self.assertNotIn("人物", tags)
        tags = m.merge_tags(["风景"], ["人物"], primary_people="一位女性")
        self.assertIn("人物", tags)

    def test_union_adds_new_categories(self):
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
        import merge_captions as m

        tags = m.merge_tags(["室内居家"], ["手机", "文字"], primary_people="")
        self.assertIn("室内居家", tags)
        self.assertIn("屏幕截图", tags)


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmp.name) / "t.sqlite"
        self._orig = db.config.DB_PATH
        db.config.DB_PATH = self.db_path
        db.init_db()

    def tearDown(self):
        db.config.DB_PATH = self._orig
        self.tmp.cleanup()

    def test_store_caption_upserts(self):
        with db.session() as con:
            caption.store_caption(con, "a1", "m", "v1", {"caption": "第一版", "tags": ["风景"]}, "{}")
            caption.store_caption(con, "a1", "m", "v1", {"caption": "第二版", "tags": ["人物"]}, "{}")
            row = con.execute("SELECT caption, tags FROM captions WHERE asset_id='a1'").fetchone()
        self.assertEqual(row["caption"], "第二版")
        self.assertEqual(json.loads(row["tags"]), ["人物"])

    def test_different_prompt_versions_coexist(self):
        with db.session() as con:
            caption.store_caption(con, "a1", "m", "v1", {"caption": "v1"}, "{}", prompt_version="p1")
            caption.store_caption(con, "a1", "m", "v1", {"caption": "v2"}, "{}", prompt_version="p2")
            rows = con.execute("SELECT prompt_version FROM captions WHERE asset_id='a1'").fetchall()
        self.assertEqual(len(rows), 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
