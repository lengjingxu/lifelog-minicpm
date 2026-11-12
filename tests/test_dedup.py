"""去重单测：不依赖模型、不依赖真实相册。"""
from __future__ import annotations

import json
import random
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from PIL import Image, ImageDraw  # noqa: E402

from lifelog import config, db, dedup  # noqa: E402


def make_photo(path: Path, seed: int, size=(800, 600)) -> None:
    """画一张有结构的图：渐变底 + 固定种子的色块，缩放后哈希仍然稳定。"""
    width, height = size
    image = Image.new("RGB", size)
    draw = ImageDraw.Draw(image)
    for y in range(height):
        t = y / max(height - 1, 1)
        draw.line(
            [(0, y), (width, y)],
            fill=(int(30 + 150 * t), int(90 + 120 * (1 - t)), int(170 - 70 * t)),
        )
    rnd = random.Random(seed)
    for _ in range(14):
        x, y = rnd.randrange(width), rnd.randrange(height)
        w, h = rnd.randrange(60, 260), rnd.randrange(60, 260)
        draw.ellipse(
            [x, y, x + w, y + h],
            fill=(rnd.randrange(256), rnd.randrange(256), rnd.randrange(256)),
        )
    image.save(path, quality=90)


def insert_asset(con, asset_id, path, size, taken_at=None, day=None, kind="image"):
    con.execute(
        "INSERT INTO assets (id, path, size, mtime, taken_at, day, kind, created_at) "
        "VALUES (?,?,?,?,?,?,?,?)",
        (asset_id, str(path), size, 0.0, taken_at, day, kind, "2026-01-01T00:00:00"),
    )


def insert_hash(con, asset_id, dhash, dhash2, w, h, sharp=10.0, sha256=None, sig=None):
    # 默认给一张中性签名：分组还要过 8x8 灰度复核，测试里不关心像素时用同一个值
    con.execute(
        "INSERT INTO asset_hash (asset_id, sha256, dhash, dhash2, w, h, computed_at, status, sharp, sig) "
        "VALUES (?,?,?,?,?,?,?,?,?,?)",
        (asset_id, sha256, dhash, dhash2, w, h, "2026-01-01T00:00:00", "ok", sharp,
         sig if sig is not None else b"\x80" * 64),
    )


class DedupBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.photos = self.root / "photos"
        self.photos.mkdir()
        self._restore = (config.DATA_DIR, config.DB_PATH)
        config.DATA_DIR = self.root
        config.DB_PATH = self.root / "lifelog.sqlite"
        db.init_db()

    def tearDown(self):
        config.DATA_DIR, config.DB_PATH = self._restore
        self.tmp.cleanup()

    def groups(self):
        with db.session() as con:
            rows = con.execute(
                "SELECT g.id, g.keeper_id, g.reason, m.asset_id, m.distance "
                "FROM dup_groups g JOIN dup_members m ON m.group_id = g.id "
                "ORDER BY g.id, m.asset_id"
            ).fetchall()
        grouped = {}
        for row in rows:
            grouped.setdefault(row["id"], {"keeper": row["keeper_id"], "reason": row["reason"], "members": []})
            grouped[row["id"]]["members"].append(row["asset_id"])
        return grouped


class DHashTests(DedupBase):
    def test_resize_and_reencode_keep_same_hash(self):
        base = self.photos / "base.jpg"
        make_photo(base, 7)
        image = Image.open(base)
        variants = {
            "half.jpg": None,
            "big.png": None,
            "q30.jpg": None,
            "crop.jpg": None,
        }
        image.resize((400, 300)).save(self.photos / "half.jpg", quality=60)
        image.resize((1200, 900)).save(self.photos / "big.png")
        image.save(self.photos / "q30.jpg", quality=30)
        image.crop((8, 8, 792, 592)).save(self.photos / "crop.jpg", quality=85)

        original = dedup.scan_image(base)
        for name in variants:
            scanned = dedup.scan_image(self.photos / name)
            self.assertLessEqual(
                dedup.hamming(original["dhash"], scanned["dhash"]),
                dedup.HAMMING_MAX,
                f"{name} 的 64bit dHash 距离超阈值",
            )
            fine = (int(original["dhash2"], 16) ^ int(scanned["dhash2"], 16)).bit_count()
            self.assertLessEqual(fine, dedup.DHASH2_MAX, f"{name} 的 256bit 复核距离超阈值")

    def test_different_photos_do_not_merge(self):
        for index in range(4):
            make_photo(self.photos / f"{index}.jpg", index)
        with db.session() as con:
            for index in range(4):
                insert_asset(con, f"a{index}", self.photos / f"{index}.jpg", 1000 + index)
            dedup.build(con)
        self.assertEqual(self.groups(), {})

    def test_multi_index_finds_distance_six(self):
        # 2 + 2 + 1 + 1：四块里最少的差 1 bit，靠单 bit 变体一定能命中
        left = 0
        right = 0b11 | (0b11 << 16) | (0b1 << 32) | (0b1 << 48)
        self.assertEqual((left ^ right).bit_count(), 6)
        self.assertEqual(dedup._dhash_edges([left, right]), [(0, 1)])

    def test_multi_index_rejects_distance_seven(self):
        left = 0
        right = 0b11 | (0b11 << 16) | (0b11 << 32) | (0b1 << 48)
        self.assertEqual((left ^ right).bit_count(), 7)
        self.assertEqual(dedup._dhash_edges([left, right]), [])

    def test_flat_images_are_not_merged(self):
        for index in range(2):
            Image.new("RGB", (600, 400), (250, 250, 250)).save(
                self.photos / f"flat{index}.jpg", quality=95
            )
        with db.session() as con:
            insert_asset(con, "f0", self.photos / "flat0.jpg", 1111)
            insert_asset(con, "f1", self.photos / "flat1.jpg", 2222)
            dedup.build(con)
        self.assertEqual(self.groups(), {})


class GroupingTests(DedupBase):
    def test_burst_window_and_resolution(self):
        # 同一天、同分辨率：0-2-5-6 秒链成一组，10 秒断链
        times = ["10:00:00", "10:00:02", "10:00:05", "10:00:06", "10:00:10"]
        hashes = [
            "00000000000000ff",
            "000000000000ff00",
            "0000000000ff0000",
            "00000000ff000000",
            "000000ff00000000",
        ]
        fine = [
            "0" * 60 + "f",
            "0" * 58 + "ff",
            "0" * 56 + "ffff",
            "0" * 54 + "ffffff",
            "0" * 52 + "ffffffff",
        ]
        with db.session() as con:
            for index, clock in enumerate(times):
                insert_asset(
                    con,
                    f"b{index}",
                    self.photos / f"b{index}.jpg",
                    100 + index,
                    taken_at=f"2026-05-01T{clock}",
                    day="2026-05-01",
                )
                insert_hash(con, f"b{index}", hashes[index], fine[index], 4000, 3000)
            # 同一秒但分辨率不同：不该进连拍组
            insert_asset(
                con,
                "other_res",
                self.photos / "other_res.jpg",
                999,
                taken_at="2026-05-01T10:00:05",
                day="2026-05-01",
            )
            insert_hash(con, "other_res", "ffffffffffffffff", "f" * 64, 1920, 1080)
            # 同一时刻但跨天：不该进连拍组
            insert_asset(
                con,
                "next_day",
                self.photos / "next_day.jpg",
                998,
                taken_at="2026-05-02T10:00:05",
                day="2026-05-02",
            )
            insert_hash(con, "next_day", "ffffffffffffff00", "f" * 62 + "00", 4000, 3000)
            dedup.group(con)

        grouped = self.groups()
        self.assertEqual(len(grouped), 1)
        members = list(grouped.values())[0]["members"]
        self.assertEqual(members, ["b0", "b1", "b2", "b3"])
        self.assertIn("burst", grouped[1]["reason"])


    def test_same_dhash_but_different_pixels_not_grouped(self):
        """低纹理图 dHash 会撞车：同哈希但像素差很远的两张，不能合并。"""
        with db.session() as con:
            for asset_id, sig in (("white", b"\xff" * 64), ("black", b"\x00" * 64)):
                insert_asset(con, asset_id, self.photos / f"{asset_id}.png", 10,
                             taken_at="2026-01-01T09:00:00", day="2026-01-01")
                insert_hash(con, asset_id, "00000000425a0000", "0" * 60 + "f", 1600, 1200, sig=sig)
            dedup.group(con)
        self.assertEqual(self.groups(), {}, "像素完全不同却因为 dHash 相同被合并了")

    def test_same_dhash_and_close_pixels_grouped(self):
        with db.session() as con:
            for asset_id, value in (("a", 128), ("b", 130)):
                insert_asset(con, asset_id, self.photos / f"{asset_id}.png", 10,
                             taken_at="2026-01-01T09:00:00", day="2026-01-01")
                insert_hash(con, asset_id, "00000000425a0000", "0" * 60 + "f", 1600, 1200,
                            sig=bytes([value]) * 64)
            dedup.group(con)
        groups = self.groups()
        self.assertEqual(len(groups), 1)
        self.assertEqual(sorted(groups[1]["members"]), ["a", "b"])
    def test_keeper_prefers_resolution_then_sharpness_then_time(self):
        with db.session() as con:
            # 分辨率最大优先
            insert_asset(con, "small", self.photos / "s.jpg", 10, taken_at="2026-01-01T09:00:00", day="2026-01-01")
            insert_hash(con, "small", "00000000000000ff", "0" * 60 + "f", 800, 600, sharp=500)
            insert_asset(con, "large", self.photos / "l.jpg", 11, taken_at="2026-01-01T11:00:00", day="2026-01-01")
            insert_hash(con, "large", "00000000000000ff", "0" * 60 + "f", 4000, 3000, sharp=1)
            dedup.group(con)
            self.assertEqual(self.groups()[1]["keeper"], "large")

        with db.session() as con:
            con.execute("DELETE FROM dup_members")
            con.execute("DELETE FROM dup_groups")
            con.execute("DELETE FROM asset_hash")
            con.execute("DELETE FROM assets")
            # 同分辨率：清晰度高的优先
            insert_asset(con, "soft", self.photos / "a.jpg", 10, taken_at="2026-01-01T09:00:00", day="2026-01-01")
            insert_hash(con, "soft", "00000000000000ff", "0" * 60 + "f", 4000, 3000, sharp=3)
            insert_asset(con, "sharp", self.photos / "b.jpg", 11, taken_at="2026-01-01T11:00:00", day="2026-01-01")
            insert_hash(con, "sharp", "00000000000000ff", "0" * 60 + "f", 4000, 3000, sharp=90)
            dedup.group(con)
            self.assertEqual(self.groups()[1]["keeper"], "sharp")

        with db.session() as con:
            con.execute("DELETE FROM dup_members")
            con.execute("DELETE FROM dup_groups")
            con.execute("DELETE FROM asset_hash")
            con.execute("DELETE FROM assets")
            # 同分辨率同清晰度：拍摄时间早的优先
            insert_asset(con, "late", self.photos / "c.jpg", 10, taken_at="2026-01-01T12:00:00", day="2026-01-01")
            insert_hash(con, "late", "00000000000000ff", "0" * 60 + "f", 4000, 3000, sharp=50)
            insert_asset(con, "early", self.photos / "d.jpg", 11, taken_at="2026-01-01T08:00:00", day="2026-01-01")
            insert_hash(con, "early", "00000000000000ff", "0" * 60 + "f", 4000, 3000, sharp=50)
            dedup.group(con)
            self.assertEqual(self.groups()[1]["keeper"], "early")

    def test_video_only_joins_byte_level_group(self):
        video = self.photos / "clip.mp4"
        video.write_bytes(b"same-bytes")
        copy = self.photos / "clip-copy.mp4"
        copy.write_bytes(b"same-bytes")
        with db.session() as con:
            insert_asset(con, "v1", video, video.stat().st_size, kind="video")
            insert_asset(con, "v2", copy, copy.stat().st_size, kind="video")
            dedup.build(con)
            row = con.execute("SELECT dhash, dhash2 FROM asset_hash WHERE asset_id='v1'").fetchone()
        self.assertIsNone(row["dhash"])
        self.assertIsNone(row["dhash2"])
        grouped = self.groups()
        self.assertEqual(list(grouped.values())[0]["reason"], "l0")


class IncrementalTests(DedupBase):
    def test_limit_then_resume(self):
        for index in range(5):
            make_photo(self.photos / f"{index}.jpg", 100 + index)
        with db.session() as con:
            for index in range(5):
                insert_asset(con, f"a{index}", self.photos / f"{index}.jpg", 500 + index)

        with db.session() as con:
            first = dedup.build(con, limit=2)
            self.assertEqual(first["hashed"], 2)
            self.assertEqual(
                con.execute("SELECT count(*) FROM asset_hash").fetchone()[0], 2
            )

        with db.session() as con:
            second = dedup.build(con)
            self.assertEqual(second["pending"], 3)
            self.assertEqual(second["hashed"], 3)
            self.assertEqual(
                con.execute("SELECT count(*) FROM asset_hash").fetchone()[0], 5
            )
            runs = con.execute(
                "SELECT finished_at FROM runs WHERE stage='dedup' ORDER BY id"
            ).fetchall()
        self.assertEqual(len(runs), 2)
        self.assertIsNotNone(runs[-1]["finished_at"])

    def test_sha256_backfill_when_size_bucket_grows(self):
        first = self.photos / "one.jpg"
        first.write_bytes(b"aaaa")
        with db.session() as con:
            insert_asset(con, "one", first, 4)
            dedup.build(con)
            row = con.execute("SELECT sha256 FROM asset_hash WHERE asset_id='one'").fetchone()
            self.assertIsNone(row["sha256"], "唯一 size 不该读盘算 sha256")

        second = self.photos / "two.jpg"
        second.write_bytes(b"bbbb")
        with db.session() as con:
            insert_asset(con, "two", second, 4)
            stats = dedup.build(con)
            rows = con.execute("SELECT asset_id, sha256 FROM asset_hash ORDER BY asset_id").fetchall()
        # 错误行现在会重跑，sha256 可能在主循环里就算掉了，两种路径都算通过
        self.assertGreaterEqual(stats["sha256"] + stats["sha256_backfilled"], 1)
        self.assertEqual(len(rows), 2)
        self.assertTrue(all(row["sha256"] for row in rows))
        self.assertEqual(len({row["sha256"] for row in rows}), 2, "不同字节不该被判成同图")


class ReadBackTests(DedupBase):
    def test_every_group_reads_back(self):
        for index in range(6):
            make_photo(self.photos / f"a{index}.jpg", 200 + index)
        # 两组：a0/a1 同字节，a2/a3 缩放同图，a4/a5 独立
        (self.photos / "a1.jpg").write_bytes((self.photos / "a0.jpg").read_bytes())
        Image.open(self.photos / "a2.jpg").resize((400, 300)).save(
            self.photos / "a3.jpg", quality=70
        )
        with db.session() as con:
            for index in range(6):
                insert_asset(con, f"a{index}", self.photos / f"a{index}.jpg", 900 + index)
            dedup.build(con)
            payload = dedup.export(con)
            group_rows = con.execute("SELECT id, keeper_id, reason FROM dup_groups ORDER BY id").fetchall()
            member_rows = con.execute(
                "SELECT group_id, asset_id FROM dup_members ORDER BY group_id, asset_id"
            ).fetchall()
            asset_ids = {row[0] for row in con.execute("SELECT id FROM assets")}

        self.assertEqual(len(payload["groups"]), len(group_rows))
        self.assertEqual(
            sum(len(group["members"]) for group in payload["groups"]), len(member_rows)
        )
        self.assertEqual(len(member_rows), len({(row["group_id"], row["asset_id"]) for row in member_rows}))
        for row in group_rows:
            members = [item["asset_id"] for item in payload["groups"][row["id"] - 1]["members"]]
            self.assertGreaterEqual(len(members), 2)
            self.assertIn(row["keeper_id"], members)
            self.assertTrue(set(members) <= asset_ids, "分组里出现了库里没有的 asset")
        self.assertEqual(
            {row["asset_id"] for row in member_rows},
            {"a0", "a1", "a2", "a3"},
        )

    def test_stats_matches_tables(self):
        make_photo(self.photos / "x.jpg", 300)
        make_photo(self.photos / "y.jpg", 301)
        (self.photos / "y2.jpg").write_bytes((self.photos / "y.jpg").read_bytes())
        with db.session() as con:
            insert_asset(con, "x", self.photos / "x.jpg", 100)
            insert_asset(con, "y", self.photos / "y.jpg", 200)
            insert_asset(con, "y2", self.photos / "y2.jpg", 200)
            dedup.build(con)
            stats = dedup.stats(con)
        self.assertEqual(stats["assets"], 3)
        self.assertEqual(stats["hashed"], 3)
        self.assertEqual(stats["pending"], 0)
        self.assertEqual(stats["groups"], 1)
        self.assertEqual(stats["grouped_assets"], 2)
        self.assertEqual(stats["duplicate_assets"], 1)
        self.assertEqual(stats["reasons"], {"l0": 1})
        self.assertEqual(stats["last_run"]["stats"] and json.loads(stats["last_run"]["stats"])["phase"], "done")


if __name__ == "__main__":
    unittest.main()

