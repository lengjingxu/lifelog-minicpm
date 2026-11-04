---
name: lifelog
description: >-
  回答关于「这个人」的生活问题：作息、常去的地方、带孩子出门的次数、旅行片段、情绪基调、
  性格与拍摄偏好分析。当用户问"我最近怎么样""我平时都在做什么""我上个月出门多吗"
  "帮我分析一下我的相册/我的性格""这些照片讲了什么"时使用。数据来自本机 MiniCPM 逐张识别过的
  私人相册，全部离线运行。
---

# 拾光 LifeLog

把私人相册变成可查询的生活记忆，然后回答关于这个人的问题。

## 两条接入方式

**1. MCP（首选，已在本机注册）** 启动：
```bash
cd /Users/leng/lifelog-minicpm && .venv/bin/python -m lifelog.mcp_server
```
工具：
- `lifelog_ask` — 自然语言提问，返回带日期与场景依据的回答（最常用）
- `lifelog_search` — 关键词检索原始记录
- `lifelog_day` — 某天/某几天的照片量与标签
- `lifelog_profile` — 生活画像与统计底稿
- `lifelog_journey` — 人生轨迹（按年份的生活片段）
- `lifelog_events` — 生活片段列表

**2. 命令行**
```bash
cd /Users/leng/lifelog-minicpm
.venv/bin/python -m lifelog.cli ask "我上个月常去哪？" --model minicpm-v-4.7-1b
.venv/bin/python -m lifelog.cli search "湖边 孩子" --limit 8
.venv/bin/python -m lifelog.cli stats
.venv/bin/python -m lifelog.cli doctor
```

## 页面

回顾页：http://127.0.0.1:8766/review
启动：`cd /Users/leng/lifelog-minicpm && .venv/bin/python -m lifelog.cli serve-web --port 8766`

页面包含：接触印相表（按年份铺开的全部照片）、生活片段、三种叙事（回顾／给十年后的你／
给家人的信）、自我画像与照片依据、关键数字。

## 数据从哪来

小米云盘相册 → 本地入库 → MiniCPM-V-4.7-1B 逐张识别（场景/人物/地点/活动/氛围/标签）
→ 聚合成天与生活片段 → MiniCPM-V-4.5-8B 写成叙事与画像。

数据库：`data/lifelog.sqlite`（assets / captions / days / events / profile 五张表）。

## 回答时的规矩

1. **只根据记录回答**，不要编造人名、地名、天气和事件；记录里没有就说「记录里看不到」。
2. **数字必须原样引用**统计底稿里的数值，不要自行换算（问「有多少张」时答案在【客观统计】段里）。
3. 涉及「住哪、职业、身份」这类记录里没有的信息，直接说看不到。
4. 展示层默认只含 **2023 年之后**、每段 3 张、且**不含截屏/票据/图表类图片**；回答时不必主动
   描述更早的照片。
5. 叙事类问题（"讲讲我这几年"）先读 `profile` 表里的 `story_diary` / `story_future` /
   `story_family`，它们已经是成篇的中文叙事；不要重新组织。

## 维护

- 每周自动管线（Cindy 定时任务，周日 03:00）：`lifelog weekly` = 增量同步 → 入库 → 识别 →
  聚合 → 画像与叙事。
- 手动增量同步：`.venv/bin/python -m lifelog.cli sync --incremental`
- 重新生成叙事/画像：`.venv/bin/python -m lifelog.cli story --all-voices`、
  `.venv/bin/python -m lifelog.cli insight`
- 改了前端样式后重新编译 Tailwind：`npm run css`（输入 `src/tailwind.css`）
