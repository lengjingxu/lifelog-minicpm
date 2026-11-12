
"""美学评分：不依赖模型的纯逻辑测试。"""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lifelog import aesthetic, config, db  # noqa: E402


class AestheticTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self._db, self._data = config.DB_PATH, config.DATA_DIR
        config.DB_PATH = self.root / "test.sqlite"
        config.DATA_DIR = self.root
        db.init_db()

    def tearDown(self):
        config.DB_PATH, config.DATA_DIR = self._db, self._data
        self.tmp.cleanup()

    def _seed(self, scores):
        with db.session() as con:
            con.executescript(aesthetic.SCHEMA)
            for i, score in enumerate(scores):
                con.execute(
                    "INSERT INTO asset_quality(asset_id, score, model, model_version) VALUES(?,?,?,?)",
                    (f"a{i}", score, aesthetic.MODEL, aesthetic.MODEL_VERSION),
                )

    def test_stars_follow_percentiles(self):
        # 10 张：最高分应得 5 星，最低分 1 星，中间按分位分布
        self._seed([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
        aesthetic.recompute_stars()
        with db.session() as con:
            rows = dict(con.execute("SELECT asset_id, stars FROM asset_quality").fetchall())
        self.assertEqual(rows["a9"], 5)
        self.assertEqual(rows["a0"], 1)
        self.assertGreater(rows["a7"], rows["a2"])

    def test_stars_are_monotonic(self):
        self._seed([3.1, 3.2, 4.0, 4.5, 5.0, 5.5, 6.0, 6.5, 7.0, 7.5])
        aesthetic.recompute_stars()
        with db.session() as con:
            pairs = con.execute(
                "SELECT score, stars FROM asset_quality ORDER BY score"
            ).fetchall()
        stars = [p[1] for p in pairs]
        self.assertEqual(stars, sorted(stars), "分数越高星级不能越低")

    def test_thumb_preferred_over_original(self):
        thumbs = self.root / "thumbs"
        thumbs.mkdir()
        (thumbs / "abc.jpg").write_bytes(b"x")
        self.assertEqual(aesthetic.thumb_path("abc"), thumbs / "abc.jpg")
        self.assertIsNone(aesthetic.thumb_path("missing"))

    def test_resolve_path_follows_library_move(self):
        moved = self.root / "photos" / "202401"
        moved.mkdir(parents=True)
        target = moved / "p.jpg"
        target.write_bytes(b"x")
        stored = Path("/old/place/data/photos/202401/p.jpg")
        self.assertEqual(aesthetic.resolve_path(stored), target)

    def test_stats_shape(self):
        self._seed([4.0, 5.0])
        stats = aesthetic.stats()
        self.assertEqual(stats["count"], 2)
        self.assertEqual(stats["model"], aesthetic.MODEL)


if __name__ == "__main__":
    unittest.main()

