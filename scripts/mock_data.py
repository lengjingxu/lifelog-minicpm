"""生成本地演示数据：合成照片 + 逐张描述 + 聚合 + 画像叙事。

用途：本机没有真实相册时，让 /review 页面有完整数据可渲染。
照片全部由 PIL 现场绘制（渐变、山峦、海面、楼宇、草地），EXIF 写入拍摄时间；
captions 直写数据库（不调用模型）；profile 写入三种叙事与画像卡。
幂等：默认 --reset 先清空 data/。

    .venv/bin/python scripts/mock_data.py [--reset]
"""
from __future__ import annotations

import argparse
import json
import random
import shutil
import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from PIL import Image, ImageDraw, ImageFilter  # noqa: E402

from lifelog import aggregate, caption, config, db  # noqa: E402

PHOTOS_DIR = config.DATA_DIR / "photos"
random.seed(20261107)

# ---------------------------------------------------------------- 合成照片


def _grad(draw: ImageDraw.ImageDraw, w: int, h: int, top, bottom) -> None:
    for y in range(h):
        t = y / max(h - 1, 1)
        color = tuple(int(a + (b - a) * t) for a, b in zip(top, bottom))
        draw.line([(0, y), (w, y)], fill=color)


def lake_photo(w: int, h: int, warm: bool) -> Image.Image:
    img = Image.new("RGB", (w, h))
    d = ImageDraw.Draw(img)
    if warm:
        _grad(d, w, h, (246, 214, 166), (122, 96, 96))
        hills = [(96, 74, 74), (66, 52, 58)]
        water = (168, 138, 108)
    else:
        _grad(d, w, h, (168, 196, 226), (214, 222, 226))
        hills = [(98, 118, 138), (70, 86, 104)]
        water = (140, 162, 178)
    horizon = int(h * 0.58)
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer)
    for i, color in enumerate(hills):
        base = horizon - 30 * (len(hills) - i)
        pts = [(0, h)]
        x = 0
        while x <= w:
            peak = base - int(60 * (1 - i * 0.3) * abs(random.random() - 0.35))
            pts.append((x, peak))
            x += w // 7
        pts += [(w, h)]
        ld.polygon(pts, fill=color + (200,))
    img.paste(Image.alpha_composite(img.convert("RGBA"), layer).convert("RGB"), (0, 0))
    d = ImageDraw.Draw(img)
    d.rectangle([0, horizon, w, h], fill=water)
    for i in range(5):
        y = horizon + 18 + i * 26
        d.line([(w // 6, y), (w // 2 + w // 5, y)], fill=tuple(
            min(255, c + 26) for c in water), width=3)
    return img


def sea_photo(w: int, h: int) -> Image.Image:
    img = Image.new("RGB", (w, h))
    d = ImageDraw.Draw(img)
    _grad(d, w, h, (146, 190, 216), (232, 214, 178))
    horizon = int(h * 0.62)
    for y in range(horizon, h):
        t = (y - horizon) / max(h - horizon, 1)
        color = (int(70 + 40 * t), int(140 + 30 * t), int(150 + 20 * t))
        d.line([(0, y), (w, y)], fill=color)
    for i in range(14):
        y = horizon + random.randint(8, h - horizon - 10)
        x = random.randint(0, w - 80)
        d.line([(x, y), (x + random.randint(24, 70), y)],
               fill=(238, 240, 236), width=2)
    d.ellipse([w * 0.68, h * 0.10, w * 0.68 + 70, h * 0.10 + 70], fill=(250, 236, 190))
    return img


def mountain_photo(w: int, h: int) -> Image.Image:
    img = Image.new("RGB", (w, h))
    d = ImageDraw.Draw(img)
    _grad(d, w, h, (214, 224, 230), (244, 244, 240))
    for i in range(4):
        base = int(h * (0.66 + i * 0.10))
        shade = 120 + i * 26
        pts = [(0, h)]
        x = 0
        while x <= w:
            pts.append((x, base - int(50 * abs(random.random() - 0.3))))
            x += w // 5
        pts += [(w, h)]
        d.polygon(pts, fill=(shade, shade + 6, shade + 16))
    snow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    sd = ImageDraw.Draw(snow)
    sd.polygon([(w * 0.3, int(h * 0.62)), (w * 0.38, int(h * 0.5)),
                (w * 0.46, int(h * 0.62))], fill=(250, 250, 252, 220))
    img.paste(Image.alpha_composite(img.convert("RGBA"), snow).convert("RGB"), (0, 0))
    return img


def city_photo(w: int, h: int, night: bool) -> Image.Image:
    img = Image.new("RGB", (w, h))
    d = ImageDraw.Draw(img)
    if night:
        _grad(d, w, h, (24, 30, 52), (60, 54, 76))
        building = (34, 38, 58)
        window = (250, 214, 130)
    else:
        _grad(d, w, h, (206, 216, 224), (240, 234, 226))
        building = (128, 138, 150)
        window = (226, 232, 238)
    x = 0
    while x < w:
        bw = random.randint(w // 10, w // 5)
        bh = random.randint(int(h * 0.3), int(h * 0.78))
        d.rectangle([x, h - bh, x + bw, h], fill=building)
        for wy in range(h - bh + 14, h - 12, 22):
            for wx in range(x + 8, x + bw - 8, 18):
                if random.random() < 0.55:
                    d.rectangle([wx, wy, wx + 8, wy + 10], fill=window)
        x += bw + random.randint(6, 20)
    return img


def park_photo(w: int, h: int) -> Image.Image:
    img = Image.new("RGB", (w, h))
    d = ImageDraw.Draw(img)
    _grad(d, w, h, (206, 228, 200), (240, 244, 224))
    ground = int(h * 0.7)
    d.rectangle([0, ground, w, h], fill=(166, 196, 138))
    for i in range(6):
        cx = random.randint(int(w * 0.05), int(w * 0.95))
        cy = ground - random.randint(10, 40)
        r = random.randint(28, 64)
        d.ellipse([cx - r, cy - r * 2, cx + r, cy], fill=(96 + i * 8, 132 + i * 6, 92))
        d.rectangle([cx - 4, cy, cx + 4, ground], fill=(112, 94, 78))
    for i in range(3):
        cx = int(w * (0.3 + i * 0.2))
        d.ellipse([cx - 12, ground - 66, cx + 12, ground - 22], fill=(70, 62, 66))
        d.ellipse([cx - 9, ground - 84, cx + 9, ground - 66], fill=(70, 62, 66))
    return img


def picnic_photo(w: int, h: int) -> Image.Image:
    img = park_photo(w, h)
    d = ImageDraw.Draw(img)
    ground = int(h * 0.7)
    mat = (226, 214, 186)
    d.polygon([(w * 0.24, ground + 26), (w * 0.72, ground + 18),
               (w * 0.78, h - 30), (w * 0.18, h - 22)], fill=mat)
    for i, color in enumerate([(210, 96, 92), (96, 148, 196), (236, 190, 96)]):
        cx = w * (0.34 + i * 0.14)
        d.ellipse([cx - 22, ground + 4, cx + 22, ground + 46], fill=color)
        d.ellipse([cx - 8, ground - 4, cx + 8, ground + 20], fill=(252, 250, 244))
    return img


def portrait_photo(w: int, h: int) -> Image.Image:
    img = Image.new("RGB", (w, h))
    d = ImageDraw.Draw(img)
    bg = random.choice([(226, 214, 200), (206, 216, 222), (232, 224, 210)])
    _grad(d, w, h, tuple(min(255, c + 14) for c in bg), bg)
    cx = w // 2
    body = (86, 78, 82)
    d.ellipse([cx - w // 5, int(h * 0.66), cx + w // 5, int(h * 1.2)], fill=body)
    d.ellipse([cx - w // 8, int(h * 0.3), cx + w // 8, int(h * 0.58)], fill=(224, 190, 158))
    return img.filter(ImageFilter.GaussianBlur(1.2))


MAKERS = {
    "lake": lambda w, h: lake_photo(w, h, warm=random.random() < 0.5),
    "sea": sea_photo,
    "mountain": mountain_photo,
    "city": lambda w, h: city_photo(w, h, night=random.random() < 0.6),
    "park": park_photo,
    "picnic": picnic_photo,
    "portrait": portrait_photo,
}

# ---------------------------------------------------------------- 事件脚本
# 每段：日期区间、张数、构图类型池、标签、地点/场景/活动/氛围模板、people 分布

SCENES = [
    dict(start="2023-06-03", days=3, n=42, kinds=("sea", "portrait", "picnic"),
         tags=["海边", "风景", "人物", "户外"], place="三亚 海边",
         scene="海边", activity="度假散步", mood="放松",
         people=("无人", "一人", "多人"),
         captions=["海边的下午，阳光斜斜地铺在沙滩上，浪一层层推上来",
                   "海平线上有一艘很小的船，阳光把桅杆照得很清楚",
                   "傍晚的海面反着光，风把遮阳伞吹得鼓起来",
                   "沙滩上留下一串脚印，通向水边",
                   "有人站在浅水里看远处",
                   "午后阳光很足，海是深浅两层的蓝"]),
    dict(start="2023-10-14", days=2, n=24, kinds=("lake", "mountain"),
         tags=["风景", "山野"], place="湖边",
         scene="湖边", activity="环湖散步", mood="平静",
         people=("无人", "无人", "一人"),
         captions=["湖面很平，远处的山完整地倒映在水里",
                   "下午四点的阳光斜着打在湖面上，有一层碎光",
                   "环湖步道旁的芦苇在风里晃，山在远处排成一列",
                   "远处的山有一层薄雾",
                   "一只水鸟贴着湖面飞过去，划出一道浅浅的水痕",
                   "岸边石头上停着一只白鹭"]),
    dict(start="2024-01-01", days=2, n=28, kinds=("lake", "portrait", "picnic"),
         tags=["风景", "人物", "活动聚会"], place="湖边 跨年营地",
         scene="户外营地", activity="跨年聚会", mood="热闹",
         people=("多人", "多人", "一人"),
         captions=["跨年那晚，营地里点了一排灯",
                   "大家围着火堆坐着，有人举起了杯子",
                   "孩子举着荧光棒跑来跑去",
                   "零点过后湖边放起了烟花",
                   "第二天清晨，湖面还有一层薄雾",
                   "帐篷外摆了一桌早饭"]),
    dict(start="2024-05-18", days=2, n=16, kinds=("city", "portrait"),
         tags=["城市建筑", "交通出行", "人物"], place="城市中心",
         scene="街区", activity="城市行走", mood="随意",
         people=("无人", "一人"),
         captions=["傍晚的写字楼亮起零星的窗",
                   "路口的天桥上能看到两条街的车流",
                   "老街的骑楼下有人在排队买小吃",
                   "地铁站口的灯牌刚亮起来",
                   "巷子尽头的墙上爬满了藤",
                   "街角的咖啡店坐满了人"]),
    dict(start="2025-03-08", days=2, n=18, kinds=("park", "portrait", "picnic"),
         tags=["儿童", "人物", "植物花卉"], place="城市公园",
         scene="公园草坪", activity="陪孩子玩耍", mood="温馨",
         people=("大人和孩子", "多人"),
         captions=["公园的草坪上，孩子追着泡泡跑",
                   "她蹲在花坛边看蚂蚁搬东西",
                   "有人推着婴儿车沿步道走",
                   "午后的树影落在草地上",
                   "孩子举着一根狗尾巴草笑",
                   "花坛里的郁金香开了一半"]),
    dict(start="2026-09-26", days=2, n=14, kinds=("picnic", "park", "portrait"),
         tags=["户外", "美食", "植物花卉", "人物"], place="郊野公园",
         scene="郊野公园", activity="野餐", mood="松弛",
         people=("多人", "一人"),
         captions=["郊野公园的草坡上铺开了餐垫",
                   "篮子里装着切好的水果和三明治",
                   "树荫下有人躺着看书",
                   "孩子把风筝放得很高",
                   "傍晚收东西时草地被晒得暖暖的",
                   "野餐垫旁边散落着几只纸杯"]),
]


def take_exif(taken: datetime) -> bytes:
    exif = Image.Exif()
    exif[0x9003] = taken.strftime("%Y:%m:%d %H:%M:%S")  # DateTimeOriginal
    exif[0x9004] = taken.strftime("%Y:%m:%d %H:%M:%S")  # DateTimeDigitized
    return exif.tobytes()


def generate_photos() -> list[dict]:
    PHOTOS_DIR.mkdir(parents=True, exist_ok=True)
    items: list[dict] = []
    for scene_idx, scene in enumerate(SCENES):
        start = datetime.fromisoformat(scene["start"])
        for i in range(scene["n"]):
            day_offset = i % scene["days"]
            taken = start + timedelta(days=day_offset,
                                      minutes=random.randint(7 * 60, 19 * 60),
                                      seconds=random.randint(0, 59))
            kind = scene["kinds"][i % len(scene["kinds"])]
            portrait = kind == "portrait" and random.random() < 0.55
            w, h = (1200, 1600) if portrait else (1600, 1200)
            img = MAKERS[kind](w, h)
            month_dir = PHOTOS_DIR / taken.strftime("%Y%m")
            month_dir.mkdir(exist_ok=True)
            name = f"mock_{scene_idx:02d}_{i:03d}_{taken.strftime('%H%M%S')}.jpg"
            path = month_dir / name
            img.save(path, "JPEG", quality=88, exif=take_exif(taken))
            tags = list(scene["tags"])
            if kind == "portrait" and "人物" not in tags:
                tags = tags[:2] + ["人物"]
            items.append(dict(path=str(path), kind=kind, tags=tags[:3],
                              scene_idx=scene_idx, taken=taken))
    return items


# ---------------------------------------------------------------- 入库与描述


def ingest_and_caption(items: list[dict]) -> int:
    from lifelog import ingest
    ingest.ingest([str(PHOTOS_DIR)])
    db.init_db()
    with db.session() as con:
        rows = con.execute("SELECT id, path FROM assets ORDER BY path").fetchall()
    path_to_id = {r["path"]: r["id"] for r in rows}
    written = 0
    with db.session() as con:
        for item in items:
            asset_id = path_to_id.get(item["path"])
            if not asset_id:
                continue
            scene = SCENES[item["scene_idx"]]
            caption_text = scene["captions"][written % len(scene["captions"])]
            payload = {
                "caption": caption_text,
                "scene": scene["scene"],
                "people": scene["people"][written % len(scene["people"])],
                "place": scene["place"],
                "activity": scene["activity"],
                "mood": scene["mood"],
                "tags": item["tags"],
            }
            caption.store_caption(con, asset_id, "minicpm-v-4.7-1b", "mock-demo",
                                  payload, raw=json.dumps(payload, ensure_ascii=False))
            written += 1
    return written


def write_profile() -> None:
    profile_text = {
        "summary_recent": (
            "这几年，你的快门大多落在户外：湖边、海边、山野。"
            "照片里的下午四点出现得最多，那是你偏爱的光线。"
            "独处的时候你在看水，热闹的时候你在陪孩子。"),
        "story_diary": (
            "2023 年 6 月，你在三亚待了三天，拍了 42 张，大部分是海。\n"
            "你拍浪推上沙滩的样子，也拍傍晚反光的海面。\n"
            "那年 10 月你去了湖边，两天 24 张，画面里几乎没有人的时候居多。\n"
            "2024 年跨年你在湖边营地，照片里第一次出现很多人：火堆、灯、烟花。\n"
            "2025 年春天起，公园草坪成了你的常驻地点，照片的主角变成了孩子。\n"
            "2026 年 9 月，你在郊野公园野餐，14 张里有一半是孩子和食物。\n"
            "这几年你拍了 142 张，下午的光出现得最多。"),
        "story_future": (
            "2023 年你拍了 66 张，其中 42 张是海。\n"
            "2024 年 44 张，跨年那两天占了 28 张。\n"
            "2025 年 18 张，全部和孩子有关。\n"
            "2026 年 14 张。\n"
            "你拍湖边和海边的次数，远多于拍街区。\n"
            "下午 16 点到 17 点是你的拍摄高峰。"),
        "story_family": (
            "2023 年 6 月我们去看了海，你拍了很多浪。\n"
            "10 月的湖边很安静，水鸟贴着湖面飞。\n"
            "跨年那晚孩子举着荧光棒跑，零点后放了烟花。\n"
            "今年春天孩子追着泡泡跑了一下午，回去路上就睡着了。\n"
            "9 月野餐那天风不大，风筝放得很高。"),
        "insight": (
            "【你偏爱下午四点的光】142 张里有 96 张拍在 15-17 点，湖边和海边的照片尤其集中。\n"
            "【独处是你的常态】66 张照片的画面里没有人，多出现在湖边和山野。\n"
            "【孩子改变了你的相册】2025 年之后，儿童出现的照片占比明显升高，集中在周末。\n"
            "【你几乎不拍室内】室内场景的照片只有个位数，户外占绝对多数。"),
    }
    db.init_db()
    with db.session() as con:
        for key, value in profile_text.items():
            con.execute(
                """INSERT INTO profile (key, value, updated_at) VALUES (?,?,?)
                   ON CONFLICT(key) DO UPDATE SET value=excluded.value,
                   updated_at=excluded.updated_at""",
                (key, value, aggregate.now_iso()))


def reset() -> None:
    if config.DATA_DIR.exists():
        for child in config.DATA_DIR.iterdir():
            if child.name == "photos":
                shutil.rmtree(child)
            elif child.name == "lifelog.sqlite":
                child.unlink()
            elif child.name in ("thumbs", "logs"):
                shutil.rmtree(child, ignore_errors=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--reset", action="store_true", help="清空 data/ 后重建")
    args = parser.parse_args()
    if args.reset:
        reset()
        print("reset data/")
    items = generate_photos()
    print(f"photos: {len(items)}")
    written = ingest_and_caption(items)
    print(f"captions: {written}")
    write_profile()
    days = aggregate.build_days()
    events = aggregate.build_events()
    print(f"days: {days}, events: {events}")


if __name__ == "__main__":
    main()
