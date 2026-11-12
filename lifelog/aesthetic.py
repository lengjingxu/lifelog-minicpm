
"""本地美学评分：CLIP ViT-L/14 + LAION-Aesthetics 头。

权重：
- CLIP ViT-L/14：HuggingFace openai/clip-vit-large-patch14（走 HF_ENDPOINT 镜像）
- 评分头：christophschuhmann/improved-aesthetic-predictor 的
  sac+logos+ava1-l14-linearMSE.pth（3.5MB，GitHub raw）

两个坑：
1. 头是在 L2 归一化后的 CLIP 特征上训练的。不归一化会输出 -20~+10 的乱数。
2. 绝对分集中在 4-6，跨库不可比。所以另存一个按库内分位数映射的 1-5 星。
"""
from __future__ import annotations

import os
import time
import urllib.request
from pathlib import Path

from . import config, db

MODEL = "clip-vit-l14+laion-ava1"
MODEL_VERSION = "1"
CLIP_REPO = "openai/clip-vit-large-patch14"
HEAD_URL = (
    "https://github.com/christophschuhmann/improved-aesthetic-predictor/raw/main/"
    "sac%2Blogos%2Bava1-l14-linearMSE.pth"
)
HEAD_NAME = "sac+logos+ava1-l14-linearMSE.pth"

SCHEMA = """
CREATE TABLE IF NOT EXISTS asset_quality (
    asset_id TEXT PRIMARY KEY,
    score REAL NOT NULL,
    stars INTEGER,
    model TEXT,
    model_version TEXT,
    created_at TEXT
);
"""

_state: dict = {}


def model_dir() -> Path:
    env = os.environ.get("LIFELOG_AESTHETIC_DIR")
    return Path(env).expanduser() if env else config.DATA_DIR / "models" / "aesthetic"


def ensure_head() -> Path:
    target = model_dir() / HEAD_NAME
    if target.exists() and target.stat().st_size > 3_000_000:
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(".part")
    with urllib.request.urlopen(HEAD_URL, timeout=120) as resp, tmp.open("wb") as out:
        out.write(resp.read())
    if tmp.stat().st_size < 3_000_000:
        tmp.unlink(missing_ok=True)
        raise RuntimeError("评分头下载不完整，检查网络后重试")
    tmp.replace(target)
    return target


def _mlp():
    import torch.nn as nn

    class MLP(nn.Module):
        def __init__(self):
            super().__init__()
            self.layers = nn.Sequential(
                nn.Linear(768, 1024), nn.Dropout(0.2),
                nn.Linear(1024, 128), nn.Dropout(0.2),
                nn.Linear(128, 64), nn.Dropout(0.1),
                nn.Linear(64, 16), nn.Linear(16, 1),
            )

        def forward(self, x):
            return self.layers(x)

    return MLP()


def load():
    """懒加载 CLIP + 评分头，进程内复用。"""
    if _state.get("model") is not None:
        return _state["model"], _state["proc"], _state["head"], _state["torch"]
    try:
        import torch
        from transformers import CLIPModel, CLIPProcessor
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError("美学评分需要 torch + transformers：pip install -e .[aesthetic]") from exc

    os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    model = CLIPModel.from_pretrained(CLIP_REPO).to(device).eval()
    proc = CLIPProcessor.from_pretrained(CLIP_REPO)
    head = _mlp()
    head.load_state_dict(torch.load(ensure_head(), map_location="cpu"))
    head.to(device).eval()
    _state.update(model=model, proc=proc, head=head, torch=torch, device=device)
    return model, proc, head, torch


def score_paths(paths: list[Path], batch: int = 16) -> list[float]:
    """批量打分，返回与 paths 等长的 1-10 分。"""
    from PIL import Image

    model, proc, head, torch = load()
    out: list[float] = []
    with torch.no_grad():
        for start in range(0, len(paths), batch):
            chunk = paths[start:start + batch]
            images = []
            for path in chunk:
                try:
                    images.append(Image.open(path).convert("RGB"))
                except Exception:
                    images.append(Image.new("RGB", (224, 224)))
            inputs = proc(images=images, return_tensors="pt").to(_state["device"])
            features = model.get_image_features(**inputs)
            features = features / features.norm(dim=-1, keepdim=True)
            out.extend(head(features).squeeze(-1).tolist())
    return out


def resolve_path(stored: Path) -> Path | None:
    """库搬过家时，按 photos/月份/文件名 的相对位置找回来。"""
    if stored.exists():
        return stored
    tail = Path(*stored.parts[-2:])
    candidate = config.DATA_DIR / "photos" / tail
    return candidate if candidate.exists() else None


def thumb_path(asset_id: str) -> Path | None:
    """优先用缩略图：解码 256px 比原图快一个数量级。"""
    for candidate in (config.DATA_DIR / "thumbs" / f"{asset_id}.jpg",
                      config.DATA_DIR / "thumbs" / "full" / f"{asset_id}.jpg"):
        if candidate.exists():
            return candidate
    return None


def build(limit: int | None = None, batch: int = 16, progress=None) -> dict:
    """给还没打分的照片补分；可中断续跑。"""
    db.init_db()
    with db.session() as con:
        con.executescript(SCHEMA)
        rows = con.execute(
            """SELECT a.id, a.path FROM assets a
               LEFT JOIN asset_quality q ON q.asset_id = a.id AND q.model_version = ?
               WHERE q.asset_id IS NULL AND a.kind = 'image'
               ORDER BY a.taken_at DESC""",
            (MODEL_VERSION,),
        ).fetchall()
    todo = []
    for r in rows:
        resolved = thumb_path(r["id"]) or resolve_path(Path(r["path"]))
        if resolved:
            todo.append((r["id"], resolved))
    if limit:
        todo = todo[:limit]

    stats = {"todo": len(todo), "scored": 0, "missing": len(rows) - len(todo), "seconds": 0.0}
    t0 = time.time()
    for start in range(0, len(todo), batch):
        chunk = todo[start:start + batch]
        scores = score_paths([p for _id, p in chunk], batch=batch)
        with db.session() as con:
            con.executemany(
                """INSERT INTO asset_quality(asset_id, score, model, model_version, created_at)
                   VALUES(?,?,?,?,datetime('now','localtime'))
                   ON CONFLICT(asset_id) DO UPDATE SET
                     score=excluded.score, model=excluded.model,
                     model_version=excluded.model_version, created_at=excluded.created_at""",
                [(aid, float(s), MODEL, MODEL_VERSION) for (aid, _p), s in zip(chunk, scores)],
            )
        stats["scored"] += len(chunk)
        if progress:
            progress(stats["scored"], len(todo))
    stats["seconds"] = round(time.time() - t0, 1)
    stats["stars"] = recompute_stars()
    return stats


def recompute_stars() -> int:
    """按库内分位数给 1-5 星：绝对分跨库不可比，分位数才稳定。"""
    with db.session() as con:
        con.executescript(SCHEMA)
        scores = [r[0] for r in con.execute(
            "SELECT score FROM asset_quality WHERE model_version=? ORDER BY score", (MODEL_VERSION,)
        )]
        if not scores:
            return 0
        n = len(scores)

        def cut(p):
            return scores[min(n - 1, int(n * p))]

        c10, c30, c60, c85 = cut(0.10), cut(0.30), cut(0.60), cut(0.85)
        con.execute(
            "UPDATE asset_quality SET stars = CASE "
            "WHEN score >= ? THEN 5 WHEN score >= ? THEN 4 "
            "WHEN score >= ? THEN 3 WHEN score >= ? THEN 2 ELSE 1 END "
            "WHERE model_version = ?",
            (c85, c60, c30, c10, MODEL_VERSION),
        )
        con.commit()
        return n


def stats() -> dict:
    with db.session() as con:
        con.executescript(SCHEMA)
        row = con.execute(
            "SELECT count(*), min(score), max(score), avg(score) FROM asset_quality WHERE model_version=?",
            (MODEL_VERSION,),
        ).fetchone()
        stars = dict(con.execute(
            "SELECT stars, count(*) FROM asset_quality WHERE model_version=? AND stars IS NOT NULL GROUP BY stars",
            (MODEL_VERSION,),
        ).fetchall())
    return {
        "model": MODEL,
        "count": row[0],
        "min": round(row[1], 2) if row[1] is not None else None,
        "max": round(row[2], 2) if row[2] is not None else None,
        "mean": round(row[3], 2) if row[3] is not None else None,
        "stars": {str(k): v for k, v in sorted(stars.items())},
    }

