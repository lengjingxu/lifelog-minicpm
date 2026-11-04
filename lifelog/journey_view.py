"""人生经历页面的渲染（本地网页与静态导出共用）。"""
from __future__ import annotations

import html

from . import journey


CSS = """
:root{--ink:#16161a;--sub:#6b6b76;--line:#e9e9ef;--card:#fff;--bg:#f7f7fa;--accent:#2f6df6}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
 font-family:-apple-system,"PingFang SC","Helvetica Neue",sans-serif;line-height:1.7}
.top{background:linear-gradient(160deg,#101425,#26314f);color:#fff;padding:44px 24px 38px}
.top-inner{max-width:980px;margin:0 auto}
.top h1{margin:0 0 10px;font-size:30px;letter-spacing:.5px}
.top .sub{color:#b9c2dd;font-size:14px}
.stats{display:flex;flex-wrap:wrap;gap:10px;margin-top:22px}
.stat{background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.16);
 border-radius:12px;padding:10px 14px;min-width:118px}
.stat b{display:block;font-size:20px}
.stat span{font-size:12px;color:#c6cee6}
.story{max-width:980px;margin:26px auto 0;background:var(--card);border:1px solid var(--line);
 border-radius:16px;padding:22px 26px;font-size:15px;white-space:pre-wrap}
.story h2{margin:0 0 10px;font-size:17px}
.story .note{font-size:12px;color:var(--sub);margin-top:14px;padding-top:10px;border-top:1px dashed var(--line)}
.wrap{max-width:980px;margin:0 auto;padding:30px 24px 70px}
.year{position:relative;margin:34px 0 14px;font-size:26px;font-weight:700;color:var(--ink)}
.year:before{content:"";position:absolute;left:-14px;top:6px;width:6px;height:26px;
 background:var(--accent);border-radius:3px}
.tl{border-left:2px solid var(--line);margin-left:8px;padding-left:22px}
.evt{position:relative;background:var(--card);border:1px solid var(--line);border-radius:14px;
 padding:16px 18px;margin:0 0 18px}
.evt:before{content:"";position:absolute;left:-29px;top:22px;width:12px;height:12px;
 border-radius:50%;background:var(--accent);border:3px solid var(--bg)}
.evt .when{font-size:12px;color:var(--sub);letter-spacing:.4px}
.evt h3{margin:4px 0 8px;font-size:17px}
.tag{display:inline-block;background:#eef3ff;color:var(--accent);border-radius:999px;
 padding:2px 10px;font-size:12px;margin:0 6px 6px 0}
.evt .sum{font-size:14px;color:#3a3a44;margin:6px 0 12px}
.strip{display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:8px}
.shot{position:relative;border-radius:10px;overflow:hidden;background:#ececf2;aspect-ratio:3/4}
.shot img{width:100%;height:100%;object-fit:cover;display:block}
.shot span{position:absolute;left:0;right:0;bottom:0;padding:14px 8px 6px;font-size:11px;
 color:#fff;background:linear-gradient(transparent,rgba(0,0,0,.72));opacity:0;transition:.2s}
.shot:hover span{opacity:1}
.foot{max-width:980px;margin:0 auto;padding:0 24px 50px;color:var(--sub);font-size:13px}
@media (max-width:560px){.strip{grid-template-columns:repeat(2,1fr)}.top h1{font-size:24px}}
"""


def _esc(text) -> str:
    return html.escape(str(text or ""))


def render_html(data: dict | None = None) -> str:
    data = data or journey.build_journey()
    stats = data["stats"]
    span = stats["span"]
    span_text = f"{span[0]} ~ {span[1]}" if span else "暂无"
    stat_cards = "".join([
        f'<div class="stat"><b>{stats["events"]}</b><span>生活片段</span></div>',
        f'<div class="stat"><b>{stats["described"]}</b><span>已理解照片</span></div>',
        f'<div class="stat"><b>{stats["active_days"]}</b><span>有照片的日子</span></div>',
        f'<div class="stat"><b>{span_text}</b><span>时间跨度</span></div>',
        f'<div class="stat"><b>{stats["coverage"]:.1%}</b><span>相册覆盖</span></div>',
    ])
    blocks = []
    for section in data["sections"]:
        events = []
        for event in section["events"]:
            tags = "".join(f'<span class="tag">{_esc(t)}</span>' for t in event["tags"])
            shots = "".join(
                f'<div class="shot"><img src="/thumb/{_esc(p["id"])}" alt=""><span>{_esc(p["caption"])}</span></div>'
                for p in event["photos"]
            )
            when = event["start_day"]
            if event["end_day"] != event["start_day"]:
                when += f" ~ {event['end_day']}"
            events.append(
                f'<div class="evt"><div class="when">{_esc(when)} · {event["photo_count"]} 张</div>'
                f'<h3>{_esc(event["title"])}</h3><div>{tags}</div>'
                f'<div class="sum">{_esc(event["summary"])}</div>'
                f'<div class="strip">{shots}</div></div>'
            )
        blocks.append(f'<div class="year">{_esc(section["year"])}</div><div class="tl">'
                      + "".join(events) + "</div>")
    story = _esc(data["summary"])
    return f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>人生经历 · 拾光 LifeLog</title><style>{CSS}</style></head><body>
<div class="top"><div class="top-inner">
<h1>人生经历</h1>
<div class="sub">由本地 MiniCPM 读过的照片还原 · 数据来自 {stats["described"]} 张已理解照片</div>
<div class="stats">{stat_cards}</div>
</div></div>
<div class="story"><h2>这份相册透露出的生活</h2>{story}
<div class="note">上面这段第一人称回顾由本地 MiniCPM-V-4.5-8B 依据下方统计底稿写成，
属于自述风格的润色表述；下方时间线里的日期、张数与照片描述才是逐张照片对应的事实。</div></div>
<div class="wrap">{"".join(blocks)}</div>
<div class="foot">生成时间 {data["generated_at"]} · 拾光 LifeLog · 全流程本地运行</div>
</body></html>"""
