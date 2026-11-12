# 拾光 · AI 能力路线

> 2026-11-12 定义。四块能力：去重、美学分级、历史记忆、风格化。两块（美学、风格化）标了「待定」，写清了要决策什么、按什么标准决。

## 0. 现在有什么（有代码依据）

**模型**（`lifelog/config.py`，全部本地 GGUF + llama.cpp）

| 模型 | 用途 | 约束 |
| --- | --- | --- |
| MiniCPM-V-4.7-1B | 全库逐张结构化描述 | 端侧轻量，主力 |
| MiniCPM-V-4.5-8B | 重点照片/成组照片深读、写日记 | 16GB 机器 ctx 只能 4096，否则 Metal OOM |
| MiniCPM-OCR-1.0 / Jev | 图内文字（截图、票据、路牌） | 互为备份 |

**管线**：`ingest` 入库 → `caption`（`describe-v1`，输出 caption/scene/people/place/activity/mood/tags）→ `ocr` → `aggregate`（`build_days`、`build_events`，gap 1 天、最少 3 张）→ `query`（中文关键词 + 日期解析 + FTS5）→ `story`（8B 写叙事）。

**已有表**：`assets` / `captions`（按 model+prompt_version 多版本，取最优）/ `days` / `events` / `profile` / `runs` / `caption_fts`。

**已对外**：`lifelog/mcp_server.py` 暴露 `lifelog_ask` / `search` / `day` / `profile` / `journey` / `events`（stdio MCP）。

**桌面端**：只读 SQLite；时间线按月聚合、分类聚合、facets；10 万级 cold 555ms / warm 143ms / RSS 124MB。

**缺**：去重（全库没有任何哈希）、美学评分、实体级记忆（只有按天/按段的事件）、桌面内的对话、任何生成能力。

---

## 1. 图片去重（P0，不需要模型）

历史照片里重复很多：同一张存了多次、连拍、截图重复保存、微信/相册各存一份。三层判定，逐层收紧：

| 层 | 方法 | 抓什么 | 成本 |
| --- | --- | --- | --- |
| L0 | `sha256` 文件字节 | 完全相同的拷贝 | 先按 size 分桶，只对同 size 的算；100k 全量读盘约 3–8 分钟 |
| L1 | dHash 64bit（缩到 9×8 灰度）+ 汉明距离 ≤ 6 | 缩放/重编码/轻微裁剪 | 解码到 256px 约 8–15ms/张，100k 约 15–25 分钟，后台跑 |
| L2 | 视觉 embedding 余弦 ≥ 0.96，再用 dHash ≤ 12 复核 | 换滤镜、加字、同场景连拍 | 需要 embedding（见 §3） |

**连拍单独处理**：同一天 + `taken_at` 相差 ≤ 3s + 分辨率相同 → 一组，保留清晰度最高的一张（清晰度用 §2 的拉普拉斯方差，不依赖模型）。

**表**

```sql
CREATE TABLE asset_hash (
  asset_id TEXT PRIMARY KEY, sha256 TEXT, dhash TEXT,
  w INTEGER, h INTEGER, computed_at TEXT
);
CREATE INDEX idx_hash_dhash ON asset_hash(dhash);

CREATE TABLE dup_groups (
  id INTEGER PRIMARY KEY, keeper_id TEXT, reason TEXT, created_at TEXT
);
CREATE TABLE dup_members (
  group_id INTEGER, asset_id TEXT, distance INTEGER,
  PRIMARY KEY (group_id, asset_id)
);
```

**增量**：入库时算哈希，只对新 asset 计算；`runs` 表记进度，可中断续跑。

**UI**：网格里重复项折叠成一张 + 角标「×3」；详情页显示「同组 3 张，保留这张」；整理视图默认跳过重复；导出仍然全量，不删任何文件。

**验收**：10 万库 L0+L1 一遍 ≤ 30 分钟、可中断续跑；抽 200 组人工核对，误合并 ≤ 2%；不出现「静默丢行」类问题（沿用游标翻页那次的教训，分组结果要能全量回读）。

---

## 2. 美学分级（P1，待定）

**要决策的是**：值不值得为「打分」引入一个模型。三条路：

| 路线 | 准确度 | 速度 | 依赖 | 说明 |
| --- | --- | --- | --- | --- |
| 启发式 | 中 | 5–10ms/张 | 无 | 清晰度/曝光/对比度/色彩/主体/构图，可解释 |
| CLIP-IQA / NIMA 小模型 | 较高 | 10–30ms/张（ANE） | 一个 ~50MB 模型 | 需要转 CoreML，跨设备一致性一般 |
| 让 VLM 直接打分 | 不稳定 | 1–3s/张 | 已有 1B 模型 | 主观、贵、同一张两次结果可能不同 |

**建议**：先做启发式，配 200 张人工标注做校准（要求 Spearman ≥ 0.6 才上线）；不够再上 CLIP-IQA。VLM 打分只用于「为什么这张好」的解释，不用于排序。

**信号**：拉普拉斯方差（清晰度）、直方图两端截断比例（曝光）、局部对比度、色彩丰富度、人脸/主体占比、三分法能量分布。

**输出**：1–5 星 + 子项分，写 `asset_quality(asset_id, score, sub_json, model_version)`。

**用在哪**：精选视图、相册封面选择、整理视图的优先级、连拍保留哪张。**不用在**：隐藏照片、自动删除。

**风险**：审美是主观的；夜景、逆光、极简构图容易被误判；跨设备分数要能复现（同版本同输入同结果）。

---

## 3. 历史记忆 + 对话 + skill（P2，价值最大）

现在只有「按天/按段的事件」，回答不了「和谁、在哪、做了什么」。要分三层：

```
fact（每张照片的 caption/ocr） → event（一次出行/一顿饭） → narrative（一段时间的回顾）
```

**实体抽取**：从已有 caption 字段抽 people / place / activity / object / time，做归一（「妈妈」「母亲」→ 同一人；「西湖」「杭州西湖」→ 同一地点）。别名表 `entity_alias` 允许人工纠正。

**事件合并**：时间间隔 ≤ 6h + 同地点（有 GPS 用 2km 半径，没有用 place 文本相同）+ 人物有交集 → 同一事件；否则新建。现在的 `build_events` 是「gap 1 天 + 至少 3 张」，太粗。

**表**（在现有 `events` 上扩）

```sql
ALTER TABLE events ADD COLUMN place TEXT;
ALTER TABLE events ADD COLUMN people TEXT;
ALTER TABLE events ADD COLUMN activity TEXT;
CREATE TABLE event_assets (event_id INTEGER, asset_id TEXT, PRIMARY KEY(event_id, asset_id));
CREATE TABLE entities (id INTEGER PRIMARY KEY, kind TEXT, name TEXT, alias TEXT);
CREATE TABLE entity_mentions (entity_id INTEGER, asset_id TEXT, event_id INTEGER, confidence REAL);
CREATE VIRTUAL TABLE memory_fts USING fts5(title, summary, place, people, activity, tokenize='unicode61');
```

**查询**：结构化条件（who/where/when/what）+ FTS；语义检索可选 `sqlite-vec`（10 万 × 512 维 float32 约 200MB，先不做，等 FTS 不够用）。

**对话**：检索 top-k 事件 → 让 1B 模型基于证据回答，**必须带引用**（事件 id + 日期 + 照片 id）；没有证据就直说「相册里没有相关记录」，不许编。

**Skill / MCP**：`mcp_server.py` 已有 6 个工具，扩三个：
- `memory_search({who, where, when, what, limit})` → 事件列表 + 证据
- `memory_timeline({since, until, who?})` → 按时间的事件流
- `memory_person({name})` → 这个人的出现轨迹（首次/最近/常去地点）

**边界**：只读、本地、显式授权；MCP 默认只暴露聚合结果，不暴露原图路径。

**验收**：30 个真实问题（「去年和谁去过海边」「我妈最近一次来是什么时候」），引用正确率 ≥ 90%，无证据时 100% 说不知道。

---

## 4. AI 修图 / 摄影风格化（P3，待定）

**要决策的是**：本地跑还是走云。本地（MLX / Core ML，Flux schnell 4-step 或 SDXL Turbo）20–60s/张、不联网、内存 8GB+；云端 3–8s/张、约 ¥0.1–0.5/张、照片要上传。

**管线**（决定路线之前就能定的部分）：

1. 结构保留：深度图或边缘图作为条件，避免主体变形
2. img2img 强度 0.35–0.55：低于 0.35 只是滤镜，高于 0.55 开始改内容
3. 一次出 4 张候选，用户选一张
4. **非破坏**：原图永不修改，结果存 `renders/{asset_id}/{preset}_{version}.jpg` + 一条 `renders` 记录，可回退

**风险**：人脸失真、画面里的文字变乱码、风格漂移；批量处理要考虑失败重试与配额。

**先做**：单张、手动触发、四个预设（胶片、黑白、夜景、油画感），验证「像照片而不是像滤镜」之后再谈批量。

---

## 5. 数据与版本（四块共用）

所有模型产物统一进 `ai_meta`，避免每加一个能力就加一张表：

```sql
CREATE TABLE ai_meta (
  asset_id TEXT, kind TEXT,            -- caption / ocr / quality / embedding / render
  model TEXT, model_version TEXT, prompt_version TEXT,
  payload TEXT, status TEXT, created_at TEXT,
  PRIMARY KEY (asset_id, kind, model, prompt_version)
);
```

重跑按 `model_version` 增量；旧版本保留，出问题能回滚对比。现有 `captions` 表暂不迁移，新能力走 `ai_meta`。

---

## 6. 里程碑

| 阶段 | 内容 | 预估 | 依赖 |
| --- | --- | --- | --- |
| M1 | 去重（L0+L1+连拍） | 3–5 天 | 无 |
| M2 | 美学启发式 + 200 张校准集 | 3–5 天 | 待定 |
| M3 | 实体抽取 + 事件合并 + 查询 | 1.5–2 周 | M1（去重后事件更准） |
| M4 | 对话 + MCP 扩三个工具 | 1 周 | M3 |
| M5 | 单张风格化 | 待定 | 路线决策 |

## 7. 开放问题

- 8B 在 16GB 上 ctx 只有 4096，长叙事要分段喂，还是换 1B 做长文？
- 10 万级 embedding 存不存、存哪（sqlite-vec 约 200MB）
- 两台机器（MacBook / Mac mini）同一个库时，去重与记忆结果怎么保持一致
- 用户发现记忆错了怎么改：改 caption？改实体别名？还是标记「这条不算」——需要纠错闭环，否则记忆会越用越偏

