"""本地网页：看照片、看描述、看生活画像。"""
from __future__ import annotations

import json
import mimetypes
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import aggregate, config, db, journey_view, profile as profile_mod

THUMB_DIR = config.DATA_DIR / "thumbs"


def _html(title: str, body: str) -> bytes:
    page = f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title>
<style>
 body{{font-family:-apple-system,"PingFang SC",sans-serif;margin:0;background:#fafafa;color:#1b1b1f}}
 header{{padding:20px 28px;background:#fff;border-bottom:1px solid #e6e6ea;position:sticky;top:0;z-index:5}}
 h1{{font-size:20px;margin:0 0 6px}} nav a{{margin-right:16px;color:#2f6df6;text-decoration:none;font-size:14px}}
 main{{padding:20px 28px;max-width:1100px;margin:0 auto}}
 .grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px}}
 .card{{background:#fff;border:1px solid #ececf0;border-radius:10px;overflow:hidden}}
 .card img{{width:100%;height:150px;object-fit:cover;display:block;background:#eee}}
 .card .meta{{padding:8px 10px;font-size:12px;color:#555}}
 .card .meta b{{color:#1b1b1f;font-weight:600}}
 .day{{background:#fff;border:1px solid #ececf0;border-radius:10px;padding:14px 16px;margin-bottom:12px}}
 .tag{{display:inline-block;background:#eef3ff;color:#2f6df6;border-radius:999px;padding:2px 9px;font-size:12px;margin:2px 4px 2px 0}}
 .story{{white-space:pre-wrap;line-height:1.85;background:#fff;border:1px solid #ececf0;border-radius:10px;padding:18px 22px}}
 table{{border-collapse:collapse;width:100%;font-size:14px;background:#fff}}
 td,th{{border-bottom:1px solid #eee;padding:7px 10px;text-align:left}}
</style></head><body>
<header><h1>{title}</h1><nav>
<a href="/journey">人生经历</a><a href="/">相册</a><a href="/profile">生活画像</a><a href="/events">生活片段</a><a href="/stats">统计</a>
</nav></header><main>{body}</main></body></html>"""
    return page.encode("utf-8")


def make_thumbnail(path: Path, asset_id: str) -> bytes | None:
    THUMB_DIR.mkdir(parents=True, exist_ok=True)
    cache = THUMB_DIR / f"{asset_id}.jpg"
    if cache.exists():
        return cache.read_bytes()
    try:
        from PIL import Image
        import pillow_heif
        pillow_heif.register_heif_opener()
        with Image.open(path) as image:
            image = image.convert("RGB")
            image.thumbnail((360, 360))
            image.save(cache, format="JPEG", quality=78)
        return cache.read_bytes()
    except Exception:
        return None


def make_full(path: Path, asset_id: str, max_side: int = 1600) -> bytes | None:
    """灯箱用的大图（最长边 1600），带本地缓存。"""
    full_dir = THUMB_DIR / "full"
    full_dir.mkdir(parents=True, exist_ok=True)
    cache = full_dir / f"{asset_id}.jpg"
    if cache.exists():
        return cache.read_bytes()
    try:
        from PIL import Image
        import pillow_heif
        pillow_heif.register_heif_opener()
        with Image.open(path) as image:
            image = image.convert("RGB")
            if max(image.size) > max_side:
                scale = max_side / max(image.size)
                image = image.resize((int(image.width * scale), int(image.height * scale)))
            image.save(cache, format="JPEG", quality=86)
        return cache.read_bytes()
    except Exception:
        return None


def render_index(con, day: str | None = None, limit: int = 60) -> str:
    if day:
        rows = con.execute(
            """SELECT a.id, a.path, a.day, a.taken_at, c.caption, c.tags
               FROM assets a LEFT JOIN current_caption c ON c.asset_id=a.id AND c.prompt_version='describe-v1'
               WHERE a.day = ? ORDER BY a.taken_at LIMIT ?""", (day, limit)).fetchall()
        title = f"{day} 的照片"
    else:
        rows = con.execute(
            """SELECT a.id, a.path, a.day, a.taken_at, c.caption, c.tags
               FROM assets a LEFT JOIN current_caption c ON c.asset_id=a.id AND c.prompt_version='describe-v1'
               WHERE a.kind='image' ORDER BY a.day DESC, a.taken_at DESC LIMIT ?""", (limit,)).fetchall()
        title = "最近的相册"
    cards = []
    for row in rows:
        tags = " ".join(f'<span class="tag">{t}</span>' for t in db.jload(row["tags"]))
        cards.append(
            f'<div class="card"><a href="/photo/{row["id"]}">'
            f'<img src="/thumb/{row["id"]}" alt=""></a>'
            f'<div class="meta"><b>{row["day"] or ""}</b> {tags}<br>'
            f'{(row["caption"] or "（未识别）")[:60]}</div></div>'
        )
    return f"<h2>{title}</h2><div class='grid'>{''.join(cards)}</div>"


def render_profile(con) -> str:
    stored = profile_mod.get_profile()
    summary = stored.get("summary") or "还没有生成生活画像，先跑 lifelog profile。"
    return f"<h2>生活画像</h2><div class='story'>{summary}</div>"


def render_events(con) -> str:
    rows = con.execute(
        "SELECT start_day, end_day, title, summary, photo_count FROM events ORDER BY start_day DESC LIMIT 60"
    ).fetchall()
    items = "".join(
        f"<div class='day'><b>{r['start_day']} ~ {r['end_day']}</b> · {r['title']} · {r['photo_count']} 张<br>"
        f"<span style='color:#555'>{r['summary'] or ''}</span></div>" for r in rows
    )
    return f"<h2>生活片段</h2>{items or '<p>还没有片段，先跑 lifelog aggregate。</p>'}"


def render_stats(con) -> str:
    stats = aggregate.compute_stats()
    body = "<pre>" + aggregate.stats_to_text(stats).replace("&", "&amp;").replace("<", "&lt;") + "</pre>"
    return f"<h2>统计底稿</h2>{body}"


class Handler(BaseHTTPRequestHandler):
    server_version = "lifelog/0.1"

    def log_message(self, *args):  # 安静一点
        pass

    def _send(self, body, content_type: str = "text/html; charset=utf-8", code: int = 200):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        params = parse_qs(parsed.query)
        db.init_db()
        with db.session() as con:
            if path == "/":
                day = (params.get("day") or [None])[0]
                self._send(_html("lifelog · 相册", render_index(con, day)))
            elif path.startswith("/day/"):
                self._send(_html("lifelog · 相册", render_index(con, path.split("/")[-1])))
            elif path in ("/journey", "/review"):
                from . import review
                self._send(review.render().encode("utf-8"))
            elif path == "/journey-simple":
                self._send(journey_view.render_html().encode("utf-8"))
            elif path == "/demo":
                demo = Path(__file__).resolve().parent.parent / "reports" / "demo" / "qa-demo.html"
                if demo.exists():
                    self._send(demo.read_bytes())
                else:
                    self._send(b"demo not generated; run scripts/gen_demo.py", "text/plain")
            elif path == "/api/journey":
                from . import journey
                payload = journey.build_journey()
                payload["sections"] = [
                    {**section, "events": [{**e, "photos": [
                        {k: p.get(k) for k in ("id", "day", "caption", "tags", "place", "activity")}
                        for p in e["photos"]]} for e in section["events"]]}
                    for section in payload["sections"]
                ]
                self._send(json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                           "application/json")
            elif path == "/profile":
                self._send(_html("lifelog · 生活画像", render_profile(con)))
            elif path == "/events":
                self._send(_html("lifelog · 生活片段", render_events(con)))
            elif path == "/stats":
                self._send(_html("lifelog · 统计", render_stats(con)))
            elif path.startswith("/assets/"):
                name = path.split("/")[-1]
                target = Path(__file__).resolve().parent / "assets" / name
                if target.exists() and target.suffix in {".css", ".js", ".png", ".svg", ".woff2"}:
                    ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
                    self._send(target.read_bytes(), ctype)
                else:
                    self._send(b"not found", "text/plain", 404)
            elif path.startswith("/photo/"):
                asset_id = path.split("/")[-1]
                row = con.execute("SELECT path FROM assets WHERE id=?", (asset_id,)).fetchone()
                if not row:
                    self._send(b"not found", "text/plain", 404)
                    return
                data = make_full(Path(row["path"]), asset_id)
                self._send(data or b"", "image/jpeg" if data else "text/plain",
                           200 if data else 404)
            elif path.startswith("/thumb/"):
                asset_id = path.split("/")[-1]
                row = con.execute("SELECT path FROM assets WHERE id=?", (asset_id,)).fetchone()
                if not row:
                    self._send(b"not found", "text/plain", 404)
                    return
                data = make_thumbnail(Path(row["path"]), asset_id)
                self._send(data or b"", "image/jpeg" if data else "text/plain", 200 if data else 404)
            elif path.startswith("/photo/"):
                asset_id = path.split("/")[-1]
                row = con.execute(
                    """SELECT a.*, c.caption, c.tags, c.scene, c.place, c.activity, c.people, c.mood
                       FROM assets a LEFT JOIN current_caption c ON c.asset_id=a.id AND c.prompt_version='describe-v1'
                       WHERE a.id=?""", (asset_id,)).fetchone()
                if not row:
                    self._send(b"not found", "text/plain", 404)
                    return
                tags = " ".join(f"<span class='tag'>{t}</span>" for t in db.jload(row["tags"]))
                body = (f"<h2>{row['day']} {row['taken_at'] or ''}</h2>"
                        f"<img src='/thumb/{asset_id}' style='max-width:320px;border-radius:8px'>"
                        f"<div class='story' style='margin-top:14px'>{row['caption'] or '（未识别）'}<br>{tags}</div>"
                        f"<p style='color:#555'>场景 {row['scene'] or '-'} · 地点 {row['place'] or '-'} · "
                        f"活动 {row['activity'] or '-'} · 人物 {row['people'] or '-'} · 氛围 {row['mood'] or '-'}</p>")
                self._send(_html("lifelog · 照片", body))
            elif path == "/api/stats":
                self._send(json.dumps(aggregate.compute_stats(), ensure_ascii=False), "application/json")
            else:
                self._send(b"not found", "text/plain", 404)


def serve(port: int = 8766, host: str = "127.0.0.1"):
    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"lifelog 网页：http://{host}:{port}")
    httpd.serve_forever()
