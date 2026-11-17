"""空间页的待清理清单：只记 id，不动文件、不删 assets 行。"""
from __future__ import annotations

import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lifelog import config, db, ops, space  # noqa: E402


class SpaceQueueTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="space-test-"))
        self._paths = (config.DATA_DIR, config.DB_PATH)
        config.DATA_DIR = self.root
        config.DB_PATH = self.root / "lifelog.sqlite"
        db.init_db()
        con = db.connect()
        rows = [
            ("a1", "/tmp/1.jpg", 100, "2024-01-01", "image"),
            ("a2", "/tmp/2.mov", 200_000_000, "2024-01-02", "video"),
            ("a3", "/tmp/3.mp4", 300, "2024-01-03", "video"),
        ]
        con.executemany(
            "INSERT INTO assets (id, path, size, day, kind) VALUES (?,?,?,?,?)", rows
        )
        con.commit()
        con.close()

    def tearDown(self):
        config.DATA_DIR, config.DB_PATH = self._paths
        for path in self.root.iterdir():
            path.unlink(missing_ok=True)
        self.root.rmdir()

    def assets(self):
        con = sqlite3.connect(config.DB_PATH)
        try:
            return con.execute("SELECT count(*) FROM assets").fetchone()[0]
        finally:
            con.close()

    def test_add_is_idempotent_and_ignores_unknown_ids(self):
        space.add_to_queue(["a1", "a1", "nope"])
        result = space.add_to_queue(["a1", "a2"])
        self.assertEqual(result["changed"], 1)
        self.assertEqual(result["count"], 2)
        self.assertEqual(result["bytes"], 200_000_100)

    def test_list_is_newest_first_with_metadata(self):
        space.add_to_queue(["a1", "a2", "a3"])
        listing = space.list_queue()
        self.assertEqual([item["asset_id"] for item in listing["items"]], ["a3", "a2", "a1"])
        self.assertEqual(listing["items"][1]["kind"], "video")
        self.assertEqual(listing["items"][1]["size"], 200_000_000)

    def test_remove_leaves_assets_untouched(self):
        space.add_to_queue(["a1", "a2"])
        result = space.remove_from_queue(["a2"])
        self.assertEqual(result["changed"], 1)
        self.assertEqual(result["count"], 1)
        self.assertEqual(self.assets(), 3)

    def test_deleted_assets_disappear_from_list(self):
        space.add_to_queue(["a1", "a2"])
        con = sqlite3.connect(config.DB_PATH)
        con.execute("DELETE FROM assets WHERE id = ?", ("a2",))
        con.commit()
        con.close()
        listing = space.list_queue()
        self.assertEqual([item["asset_id"] for item in listing["items"]], ["a1"])
        self.assertEqual(listing["count"], 1)

    def test_summary_splits_bytes_and_big_videos(self):
        report = space.summary()
        self.assertEqual(report["assets"], 3)
        self.assertEqual(report["photos"], {"count": 1, "bytes": 100})
        self.assertEqual(report["videos"], {"count": 2, "bytes": 200_000_300})
        self.assertEqual(report["big_videos"], {"count": 1, "bytes": 200_000_000})
        self.assertEqual(report["queue_count"], 0)

    def test_record_delete_keeps_queue_row_until_synced(self):
        # delete_records 只删记录；清单一律由调用方在删除成功后同步（CLI 的 record-delete 里做），
        # 否则把删除拆成两步的调用方会丢掉“文件没删掉但清单已空”的信息。
        space.add_to_queue(["a1", "a2"])
        result = ops.delete_records(["a1"])
        self.assertEqual(result["removed"]["assets"], 1)
        self.assertEqual(space.list_queue()["count"], 1, "记录删了，清单也不该再显示它")
        self.assertEqual(ops.drop_from_cleanup_queue(["a1"]), 1)
        self.assertEqual(space.list_queue()["count"], 1)


class DedupGroupTests(unittest.TestCase):
    """space.groups('dup') 必须读真实去重表，而不是「同 size」影子分组。"""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="space-dup-"))
        self._paths = (config.DATA_DIR, config.DB_PATH)
        config.DATA_DIR = self.root
        config.DB_PATH = self.root / "lifelog.sqlite"
        db.init_db()
        con = db.connect()
        con.executescript(
            "CREATE TABLE IF NOT EXISTS dup_groups (id INTEGER PRIMARY KEY, keeper_id TEXT, reason TEXT, created_at TEXT);"
            "CREATE TABLE IF NOT EXISTS dup_members (group_id INTEGER, asset_id TEXT, distance INTEGER,"
            "                          PRIMARY KEY (group_id, asset_id));"
        )
        rows = [
            ("keep1", 900),
            ("dup1", 300),
            ("dup2", 200),
            ("solo", 50),
        ]
        con.executemany(
            "INSERT INTO assets (id, path, size, kind, day, taken_at) VALUES (?, ?, ?, 'image', '2024-01-01', '2024-01-01T10:00:00')",
            [(asset_id, f"/tmp/{asset_id}.jpg", size) for asset_id, size in rows],
        )
        con.execute("INSERT INTO dup_groups VALUES (7, 'keep1', 'burst+l1', '2024-01-01')")
        con.executemany(
            "INSERT INTO dup_members VALUES (7, ?, ?)",
            [("keep1", None), ("dup1", 3), ("dup2", 5)],
        )
        con.commit()
        con.close()

    def tearDown(self):
        config.DATA_DIR, config.DB_PATH = self._paths
        for path in self.root.iterdir():
            path.unlink(missing_ok=True)
        self.root.rmdir()

    def test_groups_come_from_dedup_tables(self):
        result = space.groups("dup")["groups"]
        self.assertEqual(len(result), 1)
        group = result[0]
        self.assertEqual(group["keeper"], "keep1")
        self.assertEqual(group["count"], 3)
        self.assertEqual(group["reasons"], ["burst", "l1"])
        self.assertEqual(group["reclaim_bytes"], 500)
        # chip payload 不再带 ids（5,251 组会把 JSON 撑到 1MB+）；按需单独拉。
        self.assertNotIn("ids", group)
        con = db.connect()
        try:
            ids = space.dup_group_ids(con, 7)
        finally:
            con.close()
        self.assertEqual(ids[0], "keep1")
        self.assertNotIn("solo", ids)

    def test_views_dup_reads_dedup_tables(self):
        report = space.views()["dup"]
        self.assertEqual(report["count"], 3)
        self.assertEqual(report["groups"], 1)
        self.assertEqual(report["reclaim"], 500)
        self.assertTrue(report["ready"])

    def test_views_dup_not_ready_without_tables(self):
        con = db.connect()
        con.execute("DELETE FROM dup_members")
        con.execute("DELETE FROM dup_groups")
        con.commit()
        con.close()
        report = space.views()["dup"]
        self.assertEqual(report["count"], 0)
        self.assertFalse(report["ready"])


if __name__ == "__main__":
    unittest.main()

