"""库内去重：L0 字节、L1 dHash、连拍。

只读原图，不删不改任何文件；结果写进 asset_hash / dup_groups / dup_members。
导入期的「同字节内容」去重仍在 ingest.asset_id(content_hash=True)，这里不重写那套。

三层判定（docs/AI-ROADMAP.md §1）：
- L0：按 size 分桶，只对同 size 的文件算 sha256，抓完全相同的拷贝
- L1：dHash 64bit（9x8 灰度）+ 汉明距离 <= 6，抓缩放/重编码/轻微裁剪
  64bit 太粗，低对比度画面（雾、雪、纯色渐变）会出现「结构不同但哈希相同」，
  所以再用 256bit dHash（17x16）复核 <= 24 才合并。实测缩放/重编码是 0-1，
  1-2% 裁剪是 16-21，落在阈值内；结构不同的撞车对在 28 以上。
- 连拍：同一天 + taken_at 相差 <= 3s + 同分辨率

保留策略：分辨率最大 -> 拉普拉斯方差最高 -> taken_at 最早。
"""
from __future__ import annotations

import hashlib
import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from . import config, paths, db

DHASH_WIDTH = 9
DHASH_HEIGHT = 8
DHASH_BITS = 64
HAMMING_MAX = 6
DHASH2_SIZE = (17, 16)
DHASH2_MAX = 24
BURST_GAP_SECONDS = 3
SIG_SIDE = 8          # 8x8 灰度签名，用来复核 dHash 的候选
SIG_MAX_DIFF = 14     # 同图（缩放/重编码）的签名平均差
BURST_SIG_MAX = 26    # 连拍相邻帧的签名平均差
SHARP_SIDE = 256
BATCH_SIZE = 200

# 近乎纯色的图（白墙、纯色底截图）dHash 全 0 或全 1，彼此汉明距离天然为 0。
# 这类图只按字节判重，否则两张不同的白底截图会被合并。
DEGENERATE_MIN_BITS = 4
DEGENERATE_MAX_BITS = DHASH_BITS - 4

_HEIF_READY = False


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _ensure_heif() -> None:
    global _HEIF_READY
    if _HEIF_READY:
        return
    try:
        import pillow_heif

        pillow_heif.register_heif_opener()
    except Exception:
        pass
    _HEIF_READY = True


# ---------------------------------------------------------------- 单张计算


def file_sha256(path: Path, chunk: int = 1 << 20) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(chunk), b""):
            digest.update(block)
    return digest.hexdigest()


def asset_path(raw: str) -> Path:
    """assets.path 可能是相对路径，也可能因为库搬家而失效——交给 paths.resolve 兜底。"""
    return paths.resolve(raw)


def dhash_from_gray(gray) -> int:
    """灰度图 -> 每行相邻像素比大小的位串。"""
    width, height = gray.size
    pixels = gray.tobytes()
    bits = 0
    for row in range(height):
        offset = row * width
        for col in range(width - 1):
            bits = (bits << 1) | (1 if pixels[offset + col] > pixels[offset + col + 1] else 0)
    return bits


def dhash_hex(value: int) -> str:
    return f"{value:016x}"


def hamming(left: str | None, right: str | None) -> int | None:
    if not left or not right:
        return None
    return (int(left, 16) ^ int(right, 16)).bit_count()


def is_degenerate(value: int) -> bool:
    bits = value.bit_count()
    return bits < DEGENERATE_MIN_BITS or bits > DEGENERATE_MAX_BITS


def scan_image(path: Path) -> dict:
    """解码一张图，返回 w/h/dhash/dhash2/sharp。只读。"""
    _ensure_heif()
    from PIL import Image, ImageFilter, ImageStat

    with Image.open(path) as image:
        width, height = image.size
        # JPEG 走 draft 快速解码：1600px 原图只需要 ~400px 的像素，省掉大部分 IDCT。
        image.draft("L", (SHARP_SIDE, SHARP_SIDE))
        gray = image.convert("L")
        thumb = gray.copy()
        thumb.thumbnail((SHARP_SIDE, SHARP_SIDE), Image.Resampling.BOX)
        bits = dhash_from_gray(thumb.resize((DHASH_WIDTH, DHASH_HEIGHT), Image.Resampling.BOX))
        bits2 = dhash_from_gray(thumb.resize(DHASH2_SIZE, Image.Resampling.BOX))
        # 拉普拉斯方差：offset 不改变方差，取滤波后图像的方差即可，不需要 numpy。
        edges = thumb.filter(
            ImageFilter.Kernel((3, 3), (0, 1, 0, 1, -4, 1, 0, 1, 0), scale=1, offset=128)
        )
        sharp = ImageStat.Stat(edges).var[0]
        sig = thumb.resize((SIG_SIDE, SIG_SIDE), Image.Resampling.BOX).tobytes()
    return {
        "w": width,
        "h": height,
        "dhash": dhash_hex(bits),
        "dhash2": f"{bits2:064x}",
        "sharp": round(float(sharp), 3),
        "sig": sig,
    }


# ---------------------------------------------------------------- 增量计算


def sig_diff(left, right) -> float | None:
    """8x8 灰度签名的平均绝对差；任一方缺失返回 None。"""
    if not left or not right or len(left) != len(right):
        return None
    return sum(abs(a - b) for a, b in zip(left, right)) / len(left)


def sig_close(left, right, limit: float) -> bool:
    """签名够近才算同一张；缺失签名一律不合并（宁可漏，不可错）。"""
    diff = sig_diff(left, right)
    return diff is not None and diff <= limit


def _ensure_columns(con) -> None:
    """老库的 asset_hash 没有 sig 列，补上（SQLite 不支持 IF NOT EXISTS 加列）。"""
    columns = {row[1] for row in con.execute("PRAGMA table_info(asset_hash)")}
    if "sig" not in columns:
        con.execute("ALTER TABLE asset_hash ADD COLUMN sig BLOB")
        con.commit()


def _multi_size_buckets(con) -> set[int]:
    return {
        row[0]
        for row in con.execute(
            "SELECT size FROM assets WHERE size IS NOT NULL GROUP BY size HAVING count(*) > 1"
        )
    }


def _pending(con, limit: int | None) -> list:
    sql = (
        "SELECT a.id, a.path, a.kind, a.size FROM assets a "
        "LEFT JOIN asset_hash h ON h.asset_id = a.id "
        "WHERE h.asset_id IS NULL OR h.status = 'error' OR h.sig IS NULL ORDER BY a.size, a.id"
    )
    rows = con.execute(sql).fetchall()
    return rows[:limit] if limit else rows


def backfill_sha256(con) -> int:
    """同 size 桶里出现新成员时，给桶内还没有 sha256 的老 asset 补算。

    单独出现的 size 不可能有同字节拷贝，所以不读盘。
    """
    rows = con.execute(
        "SELECT a.id, a.path FROM assets a JOIN asset_hash h ON h.asset_id = a.id "
        "WHERE h.sha256 IS NULL AND a.size IS NOT NULL "
        "AND a.size IN (SELECT size FROM assets WHERE size IS NOT NULL "
        "               GROUP BY size HAVING count(*) > 1)"
    ).fetchall()
    done = 0
    for asset_id, path in rows:
        try:
            digest = file_sha256(asset_path(path))
        except OSError:
            continue
        con.execute("UPDATE asset_hash SET sha256=? WHERE asset_id=?", (digest, asset_id))
        done += 1
    return done


def build(con, limit: int | None = None, progress=None) -> dict:
    """增量算哈希：只处理没有 asset_hash 行的 asset，分批提交，可中断续跑。"""
    started = _now_iso()
    run_id = con.execute(
        "INSERT INTO runs (stage, model, started_at, stats) VALUES ('dedup', 'dhash', ?, ?)",
        (started, json.dumps({"phase": "hash", "done": 0})),
    ).lastrowid
    con.commit()

    _ensure_columns(con)
    multi = _multi_size_buckets(con)
    pending = _pending(con, limit)
    total = len(pending)
    stats = {
        "phase": "hash",
        "pending": total,
        "hashed": 0,
        "images": 0,
        "videos": 0,
        "sha256": 0,
        "errors": 0,
    }
    started_clock = datetime.now(timezone.utc)
    batch = []

    for asset_id, path, kind, size in pending:
        digest = None
        if size in multi:
            try:
                digest = file_sha256(asset_path(path))
                stats["sha256"] += 1
            except OSError:
                digest = None

        if kind == "video":
            batch.append((asset_id, digest, None, None, None, None, _now_iso(), "ok", None, None))
            stats["videos"] += 1
        else:
            try:
                info = scan_image(asset_path(path))
            except Exception:
                batch.append((asset_id, digest, None, None, None, None, _now_iso(), "error", None, None))
                stats["errors"] += 1
            else:
                batch.append(
                    (
                        asset_id,
                        digest,
                        info["dhash"],
                        info["dhash2"],
                        info["w"],
                        info["h"],
                        _now_iso(),
                        "ok",
                        info["sharp"],
                        info["sig"],
                    )
                )
                stats["images"] += 1

        if len(batch) >= BATCH_SIZE:
            con.executemany(
                "INSERT OR REPLACE INTO asset_hash "
                "(asset_id, sha256, dhash, dhash2, w, h, computed_at, status, sharp, sig) "
                "VALUES (?,?,?,?,?,?,?,?,?,?)",
                batch,
            )
            stats["hashed"] += len(batch)
            batch.clear()
            stats["elapsed_s"] = round(
                (datetime.now(timezone.utc) - started_clock).total_seconds(), 1
            )
            con.execute(
                "UPDATE runs SET stats=? WHERE id=?", (json.dumps(stats, ensure_ascii=False), run_id)
            )
            con.commit()
            if progress:
                progress(dict(stats))

    if batch:
        con.executemany(
            "INSERT OR REPLACE INTO asset_hash "
            "(asset_id, sha256, dhash, dhash2, w, h, computed_at, status, sharp, sig) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            batch,
        )
        stats["hashed"] += len(batch)
        con.commit()

    stats["sha256_backfilled"] = backfill_sha256(con)
    con.commit()

    stats["phase"] = "group"
    if progress:
        progress(dict(stats))
    grouped = group(con)
    stats.update(grouped)
    stats["phase"] = "done"
    stats["elapsed_s"] = round((datetime.now(timezone.utc) - started_clock).total_seconds(), 1)
    con.execute(
        "UPDATE runs SET finished_at=?, stats=? WHERE id=?",
        (_now_iso(), json.dumps(stats, ensure_ascii=False), run_id),
    )
    con.commit()
    return stats


# ---------------------------------------------------------------- 分组


class _Union:
    """并查集：根固定取字典序最小的 asset id，保证同一份数据每次分组结果一致。"""

    def __init__(self) -> None:
        self.parent: dict[str, str] = {}
        self.reasons: dict[str, set[str]] = {}

    def add(self, item: str) -> None:
        if item not in self.parent:
            self.parent[item] = item
            self.reasons[item] = set()

    def find(self, item: str) -> str:
        root = item
        while self.parent[root] != root:
            root = self.parent[root]
        while self.parent[item] != root:
            self.parent[item], item = root, self.parent[item]
        return root

    def union(self, left: str, right: str, reason: str) -> None:
        a, b = self.find(left), self.find(right)
        if a == b:
            self.reasons[a].add(reason)
            return
        if a > b:
            a, b = b, a
        self.parent[b] = a
        self.reasons[a] |= self.reasons.pop(b)
        self.reasons[a].add(reason)


def _one_bit_variants(block: int) -> list[int]:
    out = [block]
    for bit in range(16):
        out.append(block ^ (1 << bit))
    return out


def _build_index(values: list[int]) -> list[dict[int, list[int]]]:
    """64bit 切成 4 个 16bit 块建倒排索引。"""
    index: list[dict[int, list[int]]] = [defaultdict(list) for _ in range(4)]
    for position, value in enumerate(values):
        for block in range(4):
            index[block][(value >> (block * 16)) & 0xFFFF].append(position)
    return index


def _candidates(value: int, index: list[dict[int, list[int]]]) -> set[int]:
    """距离 <= 6 时至少有一块只差 <= 1 bit（四块都差 >= 2 就至少 8 bit），
    所以每块查「原值 + 17 个单 bit 变体」不会漏，返回的是超集。"""
    out: set[int] = set()
    for block in range(4):
        for variant in _one_bit_variants((value >> (block * 16)) & 0xFFFF):
            out.update(index[block].get(variant, ()))
    return out


def _dhash_edges(reps: list[int], max_distance: int = HAMMING_MAX) -> list[tuple[int, int]]:
    """返回汉明距离 <= max_distance 的下标对（测试与离线核对用）。"""
    index = _build_index(reps)
    edges: list[tuple[int, int]] = []
    for position, value in enumerate(reps):
        for other in sorted(_candidates(value, index)):
            if other <= position:
                continue
            if (value ^ reps[other]).bit_count() <= max_distance:
                edges.append((position, other))
    return edges


def _parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _group_rows(con) -> list:
    return con.execute(
        "SELECT a.id, a.taken_at, a.day, a.kind, h.sha256, h.dhash, h.dhash2, h.w, h.h, h.sharp, h.sig "
        "FROM assets a JOIN asset_hash h ON h.asset_id = a.id "
        "WHERE h.status = 'ok'"
    ).fetchall()


def group(con) -> dict:
    """从 asset_hash 重建 dup_groups / dup_members（只读 asset_hash，不读原图）。"""
    _ensure_columns(con)
    rows = _group_rows(con)
    union = _Union()
    info: dict[str, dict] = {}
    for asset_id, taken_at, day, kind, sha256, dhash, dhash2, width, height, sharp, sig in rows:
        union.add(asset_id)
        info[asset_id] = {
            "taken_at": taken_at,
            "day": day,
            "kind": kind,
            "sha256": sha256,
            "dhash": dhash,
            "dhash2": dhash2,
            "w": width,
            "h": height,
            "sharp": sharp,
            "sig": sig,
        }

    def keeper_key(asset_id: str):
        meta = info[asset_id]
        resolution = (meta["w"] or 0) * (meta["h"] or 0)
        sharp = meta["sharp"] if meta["sharp"] is not None else 0.0
        moment = _parse_time(meta["taken_at"])
        # taken_at 缺失的排最后；同条件用 id 兜底，保证每次结果一致。
        epoch = moment.timestamp() if moment else float("inf")
        return (-resolution, -sharp, epoch, asset_id)

    # L0：同字节
    by_sha: dict[str, list[str]] = defaultdict(list)
    for asset_id, meta in info.items():
        if meta["sha256"]:
            by_sha[meta["sha256"]].append(asset_id)
    for members in by_sha.values():
        members.sort()
        for other in members[1:]:
            union.union(members[0], other, "l0")

    # 连拍：同一天 + 同分辨率 + 相邻拍摄时间 <= 3s（链式）。
    # 先按 (day, w, h) 分桶，否则中间插进一张别的分辨率的照片就会把链子截断。
    timed: dict[tuple[str, int, int], list] = defaultdict(list)
    for asset_id, meta in info.items():
        moment = _parse_time(meta["taken_at"])
        if moment is None or not meta["day"] or not meta["w"] or not meta["h"]:
            continue
        timed[(meta["day"], meta["w"], meta["h"])].append((moment, asset_id))
    for items in timed.values():
        items.sort()
        for previous, current in zip(items, items[1:]):
            if (current[0] - previous[0]).total_seconds() > BURST_GAP_SECONDS:
                continue
            # 同一秒导出的截图也会满足「同天 + 同分辨率 + <=3s」，必须再过一道像素门槛
            if not sig_close(info[previous[1]]["sig"], info[current[1]]["sig"], BURST_SIG_MAX):
                continue
            union.union(previous[1], current[1], "burst")

    # L1：以每个连通块的中心点做星型聚类（中心点 = 邻居最多的那张，不是质量最好的）。
    # 不做传递闭包：A~B、B~C 但 A 与 C 差很远时，链式合并会把一批无关照片连成一坨。
    atoms: dict[str, list[str]] = defaultdict(list)
    for asset_id in info:
        atoms[union.find(asset_id)].append(asset_id)

    def signature_of(asset_id: str) -> tuple[int, int] | None:
        meta = info[asset_id]
        if meta["kind"] == "video" or not meta["dhash"] or not meta["dhash2"]:
            return None
        coarse = int(meta["dhash"], 16)
        if is_degenerate(coarse):
            return None
        return coarse, int(meta["dhash2"], 16)

    def within(left: tuple[int, int], right: tuple[int, int]) -> bool:
        return (
            (left[0] ^ right[0]).bit_count() <= HAMMING_MAX
            and (left[1] ^ right[1]).bit_count() <= DHASH2_MAX
        )

    def atom_anchor(members: list[str]) -> str:
        """连通块的匹配锚点取「中心点」（邻居最多的一张），不是质量最好的那张。

        连拍块里质量最好的可能是抖动过的一帧，拿它当锚点会把同图的缩放/裁剪副本漏掉。
        L0 大块里所有成员字节相同、哈希也相同，直接用最小 id，避免 O(n^2)。
        """
        if len(members) <= 1:
            return members[0]
        signatures = {member: signature_of(member) for member in members}
        if len(members) > 32 or any(value is None for value in signatures.values()):
            return min(members)
        best, best_count = members[0], -1
        for member in members:
            count = sum(
                1
                for other in members
                if other != member and within(signatures[member], signatures[other])
            )
            if count > best_count:
                best, best_count = member, count
        return best

    centers = {root: atom_anchor(members) for root, members in atoms.items()}
    signature: dict[str, tuple[int, int]] = {}
    for root, center in centers.items():
        value = signature_of(center)
        if value is not None:
            signature[root] = value

    by_coarse: dict[int, list[tuple[str, int]]] = defaultdict(list)
    for root, (coarse, fine) in signature.items():
        by_coarse[coarse].append((root, fine))
    coarse_values = sorted(by_coarse)
    index = _build_index(coarse_values)

    assigned: dict[str, str] = {}
    for root in sorted(signature, key=lambda item: keeper_key(centers[item])):
        if root in assigned:
            continue
        assigned[root] = root
        coarse, fine = signature[root]
        for position in _candidates(coarse, index):
            other_coarse = coarse_values[position]
            if (coarse ^ other_coarse).bit_count() > HAMMING_MAX:
                continue
            for other, other_fine in by_coarse[other_coarse]:
                if other in assigned:
                    continue
                if (fine ^ other_fine).bit_count() > DHASH2_MAX:
                    continue
                assigned[other] = root

    buckets: dict[str, list[str]] = defaultdict(list)
    bucket_reasons: dict[str, set[str]] = defaultdict(set)
    for root, members in atoms.items():
        cluster = assigned.get(root, root)
        buckets[cluster].extend(members)
        bucket_reasons[cluster] |= union.reasons[root]
        if cluster != root:
            bucket_reasons[cluster].add("l1")

    def split_by_sig(members: list[str]) -> list[list[str]]:
        """dHash 只负责找候选；最终是否同图由 8x8 灰度签名复核。

        低纹理图（白底截图、大片天空）的 dHash 会撞车，只靠汉明距离会把
        完全不同的照片并成一组——本机 239 张库实测出现过 4 张不同截图同组。
        """
        parent = {member: member for member in members}

        def find(item):
            while parent[item] != item:
                parent[item] = parent[parent[item]]
                item = parent[item]
            return item

        for index, left in enumerate(members):
            for right in members[index + 1:]:
                same_bytes = info[left]["sha256"] and info[left]["sha256"] == info[right]["sha256"]
                if same_bytes or sig_close(info[left]["sig"], info[right]["sig"], SIG_MAX_DIFF):
                    a, b = find(left), find(right)
                    if a != b:
                        parent[max(a, b)] = min(a, b)
        out: dict[str, list[str]] = defaultdict(list)
        for member in members:
            out[find(member)].append(member)
        return list(out.values())

    groups = []
    for root, members in buckets.items():
        if len(members) < 2:
            continue
        for part in split_by_sig(members):
            if len(part) < 2:
                continue
            part.sort(key=keeper_key)
            keeper = part[0]
            groups.append(
                {
                    "keeper": keeper,
                    "members": part,
                    "reason": "+".join(sorted(bucket_reasons[root])) or "l1",
                    "taken_at": info[keeper]["taken_at"] or "",
                }
            )
    groups.sort(key=lambda item: (item["taken_at"], item["keeper"]))

    created = _now_iso()
    con.execute("DELETE FROM dup_members")
    con.execute("DELETE FROM dup_groups")
    member_rows = []
    reason_counts: dict[str, int] = defaultdict(int)
    for group_id, item in enumerate(groups, 1):
        con.execute(
            "INSERT INTO dup_groups (id, keeper_id, reason, created_at) VALUES (?,?,?,?)",
            (group_id, item["keeper"], item["reason"], created),
        )
        keeper_hash = info[item["keeper"]]["dhash"]
        for asset_id in item["members"]:
            member_rows.append(
                (group_id, asset_id, hamming(keeper_hash, info[asset_id]["dhash"]))
            )
        reason_counts[item["reason"]] += 1
    con.executemany(
        "INSERT INTO dup_members (group_id, asset_id, distance) VALUES (?,?,?)", member_rows
    )
    con.commit()

    return {
        "groups": len(groups),
        "grouped_assets": len(member_rows),
        "largest_group": max((len(item["members"]) for item in groups), default=0),
        "reasons": dict(sorted(reason_counts.items())),
    }


# ---------------------------------------------------------------- 统计 / 导出


def stats(con) -> dict:
    counts = con.execute(
        "SELECT count(*) AS assets, "
        "sum(CASE WHEN kind = 'video' THEN 1 ELSE 0 END) AS videos FROM assets"
    ).fetchone()
    hashed = con.execute(
        "SELECT count(*) AS total, "
        "sum(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors, "
        "sum(CASE WHEN sha256 IS NOT NULL THEN 1 ELSE 0 END) AS sha256, "
        "sum(CASE WHEN dhash IS NOT NULL THEN 1 ELSE 0 END) AS dhash FROM asset_hash"
    ).fetchone()
    groups = con.execute("SELECT count(*) FROM dup_groups").fetchone()[0]
    members = con.execute("SELECT count(*) FROM dup_members").fetchone()[0]
    largest = con.execute(
        "SELECT coalesce(max(n), 0) FROM (SELECT count(*) AS n FROM dup_members GROUP BY group_id)"
    ).fetchone()[0]
    reasons = {
        row[0]: row[1]
        for row in con.execute("SELECT reason, count(*) FROM dup_groups GROUP BY reason ORDER BY reason")
    }
    last_run = con.execute(
        "SELECT started_at, finished_at, stats FROM runs WHERE stage = 'dedup' ORDER BY id DESC LIMIT 1"
    ).fetchone()
    return {
        "assets": counts["assets"] or 0,
        "videos": counts["videos"] or 0,
        "hashed": hashed["total"] or 0,
        "pending": max(0, (counts["assets"] or 0) - (hashed["total"] or 0)),
        "sha256": hashed["sha256"] or 0,
        "dhash": hashed["dhash"] or 0,
        "errors": hashed["errors"] or 0,
        "groups": groups,
        "grouped_assets": members,
        "duplicate_assets": max(0, members - groups),
        "largest_group": largest,
        "reasons": reasons,
        "last_run": dict(last_run) if last_run else None,
    }


def export(con) -> dict:
    """全量导出：所有组、所有成员，不截断。"""
    rows = con.execute(
        "SELECT g.id, g.keeper_id, g.reason, g.created_at, m.asset_id, m.distance, "
        "a.path, a.size, a.taken_at, a.day, h.w, h.h, h.sha256, h.dhash, h.dhash2, h.sharp "
        "FROM dup_groups g JOIN dup_members m ON m.group_id = g.id "
        "LEFT JOIN assets a ON a.id = m.asset_id "
        "LEFT JOIN asset_hash h ON h.asset_id = m.asset_id "
        "ORDER BY g.id, m.distance IS NULL, m.distance, m.asset_id"
    ).fetchall()
    groups: dict[int, dict] = {}
    for row in rows:
        group = groups.setdefault(
            row["id"],
            {
                "id": row["id"],
                "keeper_id": row["keeper_id"],
                "reason": row["reason"],
                "created_at": row["created_at"],
                "members": [],
            },
        )
        group["members"].append(
            {
                "asset_id": row["asset_id"],
                "distance": row["distance"],
                "keeper": row["asset_id"] == row["keeper_id"],
                "path": row["path"],
                "size": row["size"],
                "taken_at": row["taken_at"],
                "day": row["day"],
                "w": row["w"],
                "h": row["h"],
                "sha256": row["sha256"],
                "dhash": row["dhash"],
                "dhash2": row["dhash2"],
                "sharp": row["sharp"],
            }
        )
    return {
        "generated_at": _now_iso(),
        "stats": stats(con),
        "groups": list(groups.values()),
    }

