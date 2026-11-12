#!/usr/bin/env python3
"""去重误合并抽检：造一批带标签的样本库，跑 dedup，按标签算误合并率。

每个「场景」= 一张基准照片 + 若干已知变体（同字节拷贝 / 缩放 / 重编码 / 轻微裁剪 /
连拍 3 帧）。分组结果里如果一组混进了两个场景，就是一次误合并。

用法:
    python3 scripts/dedup_audit.py --photos data/photos --out /tmp/dedup-audit
"""
from __future__ import annotations

import argparse
import json
import random
import shutil
import sys
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from PIL import Image, ImageEnhance  # noqa: E402

from lifelog import config, db, dedup  # noqa: E402

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}


def synth_photos(count: int, scratch: Path, rnd: random.Random) -> list[Path]:
    """程序生成的对照图：构图/配色各不相同，用来把场景数补到 200+。"""
    from PIL import ImageDraw

    out: list[Path] = []
    for index in range(count):
        width, height = 1200, 900
        image = Image.new("RGB", (width, height))
        draw = ImageDraw.Draw(image)
        top = tuple(rnd.randrange(256) for _ in range(3))
        bottom = tuple(rnd.randrange(256) for _ in range(3))
        for y in range(height):
            t = y / (height - 1)
            draw.line(
                [(0, y), (width, y)],
                fill=tuple(int(a + (b - a) * t) for a, b in zip(top, bottom)),
            )
        for _ in range(rnd.randrange(3, 9)):
            x, y = rnd.randrange(width), rnd.randrange(height)
            w, h = rnd.randrange(80, 400), rnd.randrange(80, 400)
            color = tuple(rnd.randrange(256) for _ in range(3))
            if rnd.random() < 0.5:
                draw.ellipse([x, y, x + w, y + h], fill=color)
            else:
                draw.rectangle([x, y, x + w, y + h], fill=color)
        path = scratch / f"synth{index:04d}.jpg"
        image.save(path, quality=88)
        out.append(path)
    return out


def pick_bases(root: Path, count: int, rnd: random.Random, scratch: Path, synth: int) -> list[Path]:
    """挑视觉上互不相同的基准图：dHash 撞车的直接跳过，免得把「本来就一样」算成误合并。"""
    candidates = sorted(
        path for path in root.rglob("*") if path.is_file() and path.suffix.lower() in IMAGE_SUFFIXES
    )
    rnd.shuffle(candidates)
    views = candidates + synth_photos(synth, scratch, rnd)
    picked: list[Path] = []
    hashes: list[tuple[int, int]] = []
    for path in views:
        if len(picked) >= count:
            break
        try:
            info = dedup.scan_image(path)
        except Exception:
            continue
        coarse, fine = int(info["dhash"], 16), int(info["dhash2"], 16)
        if any(
            (coarse ^ other[0]).bit_count() <= dedup.HAMMING_MAX
            and (fine ^ other[1]).bit_count() <= dedup.DHASH2_MAX
            for other in hashes
        ):
            continue
        picked.append(path)
        hashes.append((coarse, fine))
    return picked


def build_library(bases: list[Path], root: Path, rnd: random.Random) -> dict[str, str]:
    """按场景生成变体，返回 asset_id -> 场景标签。"""
    photos = root / "photos"
    photos.mkdir(parents=True, exist_ok=True)
    labels: dict[str, str] = {}
    counter = 0
    base_time = datetime(2024, 3, 1, 8, 0, 0)

    for scene_index, base in enumerate(bases):
        label = f"scene{scene_index:03d}"
        moment = base_time + timedelta(hours=scene_index)
        with Image.open(base) as handle:
            image = handle.convert("RGB")
        width, height = image.size
        rows: list[tuple[Path, datetime]] = []

        def write(name: str, image_obj, taken: datetime, quality: int = 90) -> None:
            nonlocal counter
            path = photos / f"{label}-{counter:05d}-{name}.jpg"
            counter += 1
            image_obj.save(path, quality=quality)
            labels[path.name] = label
            rows.append((path, taken))

        write("copy", image, moment)
        if rnd.random() < 0.7:
            write("resized", image.resize((max(2, width // 2), max(2, height // 2))), moment)
        if rnd.random() < 0.5:
            write("reencoded", image, moment, quality=35)
        if rnd.random() < 0.4:
            margin = max(2, min(width, height) // 100)
            write("crop", image.crop((margin, margin, width - margin, height - margin)), moment)
        if rnd.random() < 0.3:
            for frame in range(3):
                # 连拍帧：轻微推近 + 平移（裁掉 1-3% 再放大回去），不引入黑边。
                inset = max(1, int(min(width, height) * 0.01 * (frame + 1)))
                shifted = image.crop(
                    (inset, inset, width - inset, height - inset)
                ).resize(
                    image.size,
                    Image.Resampling.BILINEAR,
                )
                write(
                    f"burst{frame}",
                    ImageEnhance.Brightness(shifted).enhance(1.0 + frame * 0.02),
                    moment + timedelta(seconds=frame),
                )

        for path, taken in rows:
            with db.session() as con:
                con.execute(
                    "INSERT INTO assets (id, path, size, mtime, taken_at, day, kind, created_at) "
                    "VALUES (?,?,?,?,?,?,?,?)",
                    (
                        path.name,
                        str(path),
                        path.stat().st_size,
                        0.0,
                        taken.isoformat(timespec="seconds"),
                        taken.strftime("%Y-%m-%d"),
                        "image",
                        taken.isoformat(timespec="seconds"),
                    ),
                )
    return labels


def main() -> int:
    parser = argparse.ArgumentParser(description="去重误合并抽检")
    parser.add_argument("--photos", required=True, help="基准照片目录")
    parser.add_argument("--out", required=True, help="输出目录（库 + 报告）")
    parser.add_argument("--scenes", type=int, default=200, help="场景数（默认 200）")
    parser.add_argument("--sample", type=int, default=200, help="写进报告供人工核对的组数")
    parser.add_argument("--synth", type=int, default=200, help="程序生成的对照图数量")
    parser.add_argument("--seed", type=int, default=20261112)
    args = parser.parse_args()

    rnd = random.Random(args.seed)
    out = Path(args.out).expanduser().resolve()
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    scratch = out / "views"
    scratch.mkdir()
    bases = pick_bases(
        Path(args.photos).expanduser().resolve(), args.scenes, rnd, scratch, args.synth
    )
    if not bases:
        raise SystemExit("没有找到可用的基准照片")

    restore = (config.DATA_DIR, config.DB_PATH)
    config.DATA_DIR = out
    config.DB_PATH = out / "lifelog.sqlite"
    try:
        db.init_db()
        labels = build_library(bases, out, rnd)
        with db.session() as con:
            stats = dedup.build(con)
            groups = dedup.export(con)["groups"]
    finally:
        config.DATA_DIR, config.DB_PATH = restore

    total_groups = len(groups)
    false_groups = []
    pure_groups = 0
    grouped = 0
    for group in groups:
        scenes = {labels.get(member["asset_id"], "?") for member in group["members"]}
        grouped += len(group["members"])
        if len(scenes) > 1:
            false_groups.append(
                {
                    "id": group["id"],
                    "reason": group["reason"],
                    "scenes": sorted(scenes),
                    "members": [
                        {
                            "asset_id": member["asset_id"],
                            "scene": labels.get(member["asset_id"], "?"),
                            "path": member["path"],
                            "w": member["w"],
                            "h": member["h"],
                            "distance": member["distance"],
                            "sha256": (member["sha256"] or "")[:12],
                        }
                        for member in group["members"]
                    ],
                }
            )
        else:
            pure_groups += 1

    # 召回：每个场景的 copy 之外，有多少变体被并进了同一组
    by_asset = {}
    for group in groups:
        for member in group["members"]:
            by_asset[member["asset_id"]] = group["id"]
    copy_by_scene = {
        label: asset for asset, label in labels.items() if asset.endswith("-copy.jpg")
    }
    variants = [asset for asset, label in labels.items() if not asset.endswith("-copy.jpg")]
    recalled = sum(
        1
        for asset in variants
        if by_asset.get(asset) is not None
        and by_asset.get(asset) == by_asset.get(copy_by_scene.get(labels[asset], ""))
    )

    report = {
        "scenes": len(bases),
        "assets": len(labels),
        "groups": total_groups,
        "grouped_assets": grouped,
        "pure_groups": pure_groups,
        "false_merge_groups": len(false_groups),
        "false_merge_rate": round(len(false_groups) / total_groups, 4) if total_groups else 0.0,
        "variant_recall": round(recalled / len(variants), 4) if variants else 0.0,
        "variants": len(variants),
        "dedup": stats,
        "samples": [],
        "review": false_groups,
    }
    # 均匀抽 sample 组写进报告，方便人工逐组打开核对（路径都在 out/photos 下）。
    step = max(1, total_groups // max(1, args.sample))
    for group in groups[::step][: args.sample]:
        report["samples"].append(
            {
                "id": group["id"],
                "reason": group["reason"],
                "keeper_id": group["keeper_id"],
                "scenes": sorted({labels.get(member["asset_id"], "?") for member in group["members"]}),
                "members": [
                    {
                        "asset_id": member["asset_id"],
                        "scene": labels.get(member["asset_id"], "?"),
                        "path": member["path"],
                        "w": member["w"],
                        "h": member["h"],
                        "distance": member["distance"],
                    }
                    for member in group["members"]
                ],
            }
        )
    (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({key: report[key] for key in (
        "scenes", "assets", "groups", "grouped_assets", "pure_groups",
        "false_merge_groups", "false_merge_rate", "variant_recall", "variants",
    )}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

