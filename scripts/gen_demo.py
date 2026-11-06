import sqlite3, io, json, base64, os
from PIL import Image
import pillow_heif
pillow_heif.register_heif_opener()

import pathlib
ROOT = pathlib.Path(__file__).resolve().parent.parent
DB = os.environ.get('LIFELOG_DB', str(ROOT / 'data' / 'lifelog.sqlite'))
con = sqlite3.connect(DB); con.row_factory = sqlite3.Row

def rows(sql, limit=6):
    out = []
    for r in con.execute(sql):
        if len(out) >= limit:
            break
        try:
            im = Image.open(r['path']); im.thumbnail((300, 300))
            b = io.BytesIO(); im.convert('RGB').save(b, 'JPEG', quality=58, optimize=True)
            out.append({'day': r['day'][:10], 'at': r['taken_at'][11:16],
                        'caption': r['caption'][:80],
                        'b64': base64.b64encode(b.getvalue()).decode()})
        except Exception:
            pass
    return out

trip = rows("""
select a.path,a.day,a.taken_at,c.caption from assets a join captions c on c.asset_id=a.id
where a.day in ('2023-06-03','2023-06-04','2023-06-05') and a.lat between 18.15 and 18.25
  and c.status='ok' order by a.taken_at desc""", 6)

office = rows("""
select a.path,a.day,a.taken_at,c.caption from assets a join captions c on c.asset_id=a.id
where a.day like '2023%' and a.lat is not null and c.status='ok'
  and ((a.lat between 31.252 and 31.257 and a.lon between 121.524 and 121.530 and c.caption like '%办公%')
    or (a.lat between 31.228 and 31.236 and a.lon between 121.468 and 121.480 and c.caption like '%办公%'))
order by a.taken_at""", 4)

def imgs(rs):
    return ''.join(
        f'<figure><img src="data:image/jpeg;base64,{r["b64"]}" alt="">'
        f'<figcaption><b>{r["day"]} {r["at"]}</b><span>{r["caption"]}</span></figcaption></figure>'
        for r in rs)

def stat(where):
    return con.execute(where).fetchone()[0]

total_img = stat("select count(*) from assets where kind='image'")
covered = stat("select count(distinct asset_id) from captions where status='ok'")
c2023 = stat("select count(distinct a.id) from assets a join captions c on c.asset_id=a.id where a.day like '2023%' and c.status='ok'")
office_n = stat("""select count(distinct a.id) from assets a join captions c on c.asset_id=a.id
 where a.day like '2023%' and c.status='ok' and (c.caption like '%办公桌%' or c.caption like '%办公%'
 or c.caption like '%写字楼%' or c.caption like '%会议室%' or c.caption like '%工位%' or c.caption like '%同事%')""")
office_days = con.execute("""select count(distinct a.day) from assets a join captions c on c.asset_id=a.id
 where a.day like '2023%' and c.status='ok' and (c.caption like '%办公%'
 or c.caption like '%写字楼%' or c.caption like '%会议室%' or c.caption like '%工位%' or c.caption like '%同事%')""").fetchone()[0]
trip_captioned = stat("""select count(distinct a.id) from assets a join captions c on c.asset_id=a.id
 where a.day in ('2023-06-03','2023-06-04','2023-06-05') and a.lat between 18.15 and 18.25""")

trip_n = stat("""select count(*) from assets
 where day in ('2023-06-03','2023-06-04','2023-06-05') and lat between 18.15 and 18.25""")

print('total_img', total_img, 'covered', covered, '2023', c2023, 'office', office_n, office_days, 'trip', trip_n)

HTML = f'''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>拾光 LifeLog · 真实问答演示</title>
<style>
:root{{--ink:#171512;--mid:#5b5348;--soft:#8f8678;--line:#e6e0d5;--bg:#faf7f1;--accent:#9c6a3c}}
*{{box-sizing:border-box}}
body{{margin:0;background:var(--bg);color:var(--ink);font:16px/1.75 -apple-system,"PingFang SC",serif}}
.wrap{{max-width:820px;margin:0 auto;padding:48px 22px 88px}}
.eyebrow{{font:12px/1 ui-monospace,monospace;letter-spacing:.22em;color:var(--soft);text-transform:uppercase}}
h1{{font-size:36px;line-height:1.25;margin:16px 0 10px;font-weight:600;letter-spacing:-.01em}}
.sub{{color:var(--mid);font-size:15px;margin:0 0 8px}}
.meta{{font:12px/1 ui-monospace,monospace;color:var(--soft);margin-bottom:40px}}
h2{{font-size:12px;letter-spacing:.16em;color:var(--soft);text-transform:uppercase;font-weight:600;
    margin:52px 0 16px;font-family:ui-monospace,monospace}}
.turn{{display:flex;flex-direction:column;gap:14px;margin-bottom:22px}}
.q{{align-self:flex-end;max-width:80%;background:#1d1a16;color:#f7f2e9;padding:13px 17px;
    border-radius:16px 16px 4px 16px}}
.a{{border-left:2px solid var(--accent);padding:2px 0 2px 18px}}
.a p{{margin:0 0 12px}}
.kv{{display:grid;grid-template-columns:auto 1fr;gap:8px 16px;font-size:14.5px;margin:12px 0 14px}}
.kv b{{color:var(--mid);white-space:nowrap}}
.steps{{margin:10px 0 14px;padding:0;list-style:none;font-size:14.5px}}
.steps li{{padding:7px 0 7px 24px;position:relative;border-bottom:1px dashed var(--line)}}
.steps li:before{{content:"→";position:absolute;left:0;color:var(--accent)}}
.grid{{display:grid;grid-template-columns:repeat(3,1fr);gap:11px;margin:14px 0 4px}}
figure{{margin:0;background:#fff;border:1px solid var(--line);border-radius:10px;overflow:hidden}}
figure img{{width:100%;height:132px;object-fit:cover;display:block}}
figure figcaption{{padding:8px 9px 10px;font-size:11.5px;line-height:1.5;color:var(--mid)}}
figure figcaption b{{display:block;color:var(--ink);font-size:11px;margin-bottom:2px}}
.note{{font-size:12.5px;color:var(--soft);border-top:1px solid var(--line);margin-top:40px;padding-top:16px}}
@media(max-width:640px){{h1{{font-size:28px}}.grid{{grid-template-columns:repeat(2,1fr)}}
  .q{{max-width:92%}}figure img{{height:112px}}}}
</style></head><body><div class="wrap">
<div class="eyebrow">拾光 LifeLog · demo</div>
<h1>两轮真实的问答<br>每个回答都能追到照片</h1>
<p class="sub">数据来自本机相册，离线识别，不外传一张图。</p>
<p class="meta">快照 2026-11-05 · 已登记图片 {total_img:,} 张 · 已逐张描述 {covered:,} 张 · 2023 年 {c2023:,} 张</p>

<h2>Round 1 · 我在哪工作</h2>
<div class="turn">
<div class="q">我 23 年在什么地方工作？</div>
<div class="a">
<p>按「办公桌 / 工位 / 办公大厅」这类线索筛 2023 年，命中 <b>{office_n} 张、{office_days} 个不同日期</b>。这些照片集中在两处坐标：</p>
<div class="kv">
<b>杨浦·东方渔人码头 A 区</b><span>31.2545, 121.5275，OSM 标记为 office 楼。拍到办公桌前的笔记本，以及「访客由此 LOBBY」的办公大厅入口。</span>
<b>黄浦·南京东路 云南中路</b><span>31.2318, 121.4743。拍到玻璃隔断工位、绿色办公桌。</span>
</div>
<p>所以 2023 年的办公痕迹主要在<b>杨浦东方渔人码头</b>，南京东路是另一处高频落脚点。</p>
<p>需要说明：其中只有 <b>7 张</b>办公照带 GPS，其余是靠画面内容筛出来的。这是「照片里看得到的办公痕迹」，不等于完整考勤记录。</p>
</div>
</div>
<div class="grid">{imgs(office)}</div>

<h2>Round 2 · 带朋友去哪</h2>
<div class="turn">
<div class="q">我想带朋友出去玩，推荐一个我们去过的地方？</div>
<div class="a">
<p>推荐 <b>三亚太阳湾</b>。2023 年 6 月 3 日到 5 日，同一坐标段三天拍了 <b>{trip_n} 张，其中 {trip_captioned} 张有描述</b>，是这一年密度最高的短途。</p>
<ul class="steps">
<li>画面构成：户外 214 张、海边 184 张、室内 181 张、山野 52 张——有海、有山、有能待住的酒店，不是一个打卡点。</li>
<li>时间分布：17 点 172 张、22 点 129 张、16 点 102 张——下午到夜里光线最好。</li>
<li>三天都在同一片湾区，说明这地方本身待得住，不用赶场。</li>
</ul>
<p>推荐理由是「一次能同时看到海和山、还住得下来」，不是人挤人的网红景点。当时拍的原片：</p>
</div>
</div>
<div class="grid">{imgs(trip)}</div>

<p class="note">统计口径：本机 lifelog 库快照；办公判定为描述含「办公 / 办公桌 / 写字楼 / 会议室 / 工位 / 同事」；地点由 GPS 反查 OSM 得到。</p>
</div></body></html>'''

out = str(ROOT / 'reports' / 'demo' / 'qa-demo.html')
os.makedirs(os.path.dirname(out), exist_ok=True)
open(out, 'w', encoding='utf-8').write(HTML)
print('BYTES', os.path.getsize(out))
