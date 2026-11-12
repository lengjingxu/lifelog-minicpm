# 拾光 · AI 能力路线

> 2026-11-12 定义，同日调研并定下美学与风格化的模型选型。四块能力：去重、美学分级、历史记忆、风格化。历史记忆按主人要求暂不开始。

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

## 2. 美学分级（P1，调研完成，模型已定）

**结论：有现成模型，不用自己训，也不用 VLM 打分。**

| 用途 | 方案 | 速度 | 说明 |
| --- | --- | --- | --- |
| 美学分 | LAION-Aesthetics v2（CLIP ViT-L/14 + MLP 头） | 10–20ms/张 | 输出 1–10，映射到 1–5；有 CoreML 现成转换 |
| 美学分（轻量备选） | `rsinema/aesthetic-scorer`（ViT-B/32，7 个子项） | ~10ms/张 | MLX 原生，Apple Silicon 直接跑 |
| 技术质量 | 启发式：拉普拉斯方差、直方图截断、局部对比度 | <5ms/张 | 可解释，不依赖模型 |
| 技术质量（备选） | TOPIQ / MUSIQ（IQA 榜单前列） | 20–40ms/张 | 需要转 CoreML/ONNX，先用启发式够就不上 |

**建议组合**：LAION 美学分（排序）+ 启发式技术分（筛掉糊片/过曝），两个都本地、都 <20ms。VLM 打分只用于「为什么这张好」的一句话解释，不参与排序。

### 相关项目与讨论（2026-11-13 调研）

主人记得「有一个算法是基于专业设计师的照片训练出来的」。核对下来，最接近的是这两个：

| 项目 | 训练数据 | 可用性 | 结论 |
| --- | --- | --- | --- |
| **Chambe et al., Deep learning for assessing the aesthetics of professional photographs**（CAV 2022） | 六类专业摄影数据集（时尚杂志大片、产品、建筑等） | 论文，无公开权重 | 最接近「专业照片训练」。核心发现：**AVA 训练的模型（NIMA 等）在专业照片上不泛化**；专业照片的分数集中在 5–6 的窄区间，AVA 是 3–8。用专业照片微调后覆盖率明显提升 |
| **Everypixel Stock Photo Quality** | 专业图库照片，按图库编辑的视角标注 | 商业 API，$0.6/1000 次，500 次免费 | 现在就能调用的「专业标准」打分，0–100 + 等级；另有 UGC 模型（34.7 万张 Instagram 照片） |

其余相关但不等价：

- **AVA**（25 万张 DPChallenge 参赛照，每张约 200 人打分）——NIMA、LAION-Aesthetics 的底座，**是业余比赛照，不是专业作品**
- **AADB**（1 万张，11 个属性）——属性项（三分法、色彩和谐、景深、光线…）是**按专业摄影师建议选的**，但打分仍是众包
- **VIDIART**（vidiart.org）——拿前沿模型盲评 FOTOAWARD 八季约 3.4 万张、和真实专业评审团对比；AUC 0.79–0.85，说明「能部分预测评审结果，但不可靠」。是讨论，不是模型
- **AesBench / AesBiasBench / AesCanvas**（2025–2026）——评测结论一致：MLLM 的美学判断不稳、且受人群刻板印象影响；AesCanvas 用 51.9 万条专业点评做 critique 数据集

**对拾光的含义**：如果目标是「像专业评审那样打分」，直接用 AVA 系（NIMA/LAION）会系统性低估专业感强的照片——这正是那篇论文的结论。三条路：
1. LAION 做通用排序（本地、10–20ms），够用
2. Everypixel 做「专业标准」对照（API，便宜，可当校准锚）
3. 用自己 200–500 张标好的照片微调一个头（论文验证过有效），最贴合个人口味

**已有实现（可复用）**：2026-10-07 做过一个「构图眼」单文件网页（`documents/2026-10-07-构图眼.html`），纯前端启发式构图评分：
- 降采样转灰度 → 分块算方差与均值 → 主体块 = `max(方差 × (0.3 + 0.7 × 均值))`
- 主体到「四个三分点 + 中心」的最小距离 → `score = max(0, 100 - minDist × 180)`
- 另用 Sobel 找最强横/竖线做辅助线，>70 绿 / >40 黄 / 其余红

它只评构图位置，不看曝光、清晰度、色彩；而且要在取景时实时跑。**可以直接把这段逻辑搬成「构图」子项**，和 LAION 总分互补，不用重新发明。


**校准**：拿 200 张人工标 1–5 星，要求 Spearman ≥ 0.6 再上线；不达标就换成 rsinema 那版对比。

**输出**：1–5 星 + 子项分，写 `asset_quality(asset_id, score, sub_json, model_version)`。

**用在哪**：精选视图、相册封面、整理视图优先级、连拍保留哪张。**不用在**：隐藏照片、自动删除。

**风险**：审美主观；夜景/逆光/极简构图容易误判；同版本同输入必须同结果（模型固定 seed 与预处理）。

## 3. 历史记忆 + 对话 + skill（P2，暂不开始）

> 主人 2026-11-12 决定先不做：「比较难调整」。方案保留，等去重和美学落地后再评估。

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

## 4. AI 修图 / 摄影风格化（P3，本地可行，已选型）

**结论：本机能跑，走本地优先；云端 gpt-image-2.5 作为精修档。**

本机：Apple M4 Pro / 24GB。实测与公开数据：

| 方案 | 1024px 单张 | 峰值内存 | 备注 |
| --- | ---: | ---: | --- |
| FLUX.2 klein 4B（MLX 4bit） | **16.3–16.7s**（M4 16GB 实测） | ~6GB | 支持图生图/多参考编辑 |
| FLUX.1 schnell（mflux，2–4 步） | ~34s（M4 Pro 64GB） | 18–23GB | 24GB 机器要量化，偏紧 |
| ComfyUI + GGUF klein 4B | ~90s（M4 24GB） | — | 慢，不选 |

**决定**
- 默认本地：FLUX.2 klein 4B（MLX 4bit）批量出图，一次 4 张候选 ≈ 1 分钟，后台跑
- 精修档：云端 gpt-image-2.5（已有包月），单张、手动触发
- 切换阈值：本地 p50 > 25s/张 或峰值内存 > 12GB，就把默认档改成云端

**管线**（两条路共用）
1. 结构保留：深度/边缘条件，避免主体变形
2. img2img 强度 0.35–0.55：低于 0.35 只是滤镜，高于 0.55 开始改内容
3. 一次出 4 张候选，用户选一张
4. **非破坏**：原图永不修改，结果存 `renders/{asset_id}/{preset}_{version}.jpg` + `renders` 记录，可回退

**风险**：人脸失真、画面文字变乱码、风格漂移；批量要考虑失败重试与配额。

**先做**：单张、手动触发、四个预设（胶片、黑白、夜景、油画感），验证「像照片而不是像滤镜」之后再谈批量。

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

## 6. 当前执行

| 事项 | 状态 | 位置 |
| --- | --- | --- |
| M1 去重 | 进行中（后台任务 41a88735） | lifelog/dedup.py + 桌面 dup_groups() |
| M2 美学 | 待开工，模型已选 | 见 §2 |
| M3/M4 记忆 | 暂缓 | 见 §3 |
| M5 风格化 | 待开工，模型已选 | 见 §4 |

## 7. 里程碑

| 阶段 | 内容 | 预估 | 依赖 |
| --- | --- | --- | --- |
| M1 | 去重（L0+L1+连拍） | 3–5 天 | 无 |
| M2 | 美学：LAION 美学分 + 启发式技术分 + 200 张校准 | 3–5 天 | 模型已选 |
| M3 | 实体抽取 + 事件合并 + 查询 | 暂缓 | 主人决定先不做 |
| M4 | 对话 + MCP 扩三个工具 | 暂缓 | M3 |
| M5 | 单张风格化（本地 FLUX.2 klein 4B，精修走云端） | 待定 | 模型已选 |

## 8. 开放问题

- 8B 在 16GB 上 ctx 只有 4096，长叙事要分段喂，还是换 1B 做长文？
- 10 万级 embedding 存不存、存哪（sqlite-vec 约 200MB）
- 两台机器（MacBook / Mac mini）同一个库时，去重与记忆结果怎么保持一致
- 用户发现记忆错了怎么改：改 caption？改实体别名？还是标记「这条不算」——需要纠错闭环，否则记忆会越用越偏

