# 性能基线 · 帧率

桌面端现在的动画基线，用来对比后续 UI 改动（主题切换、液态玻璃、连续动效）有没有掉帧。

## 怎么测

脚本：`scripts/measure_fps.py`（只用标准库，自带 headless Chrome + CDP）

```bash
# 先在另一个终端起 dev server（浏览器 fixture 模式，不依赖 Tauri）
npm run dev -- --port 5176

# 再跑采样（--theme 会给 URL 加 ?theme=dark|light，只影响本次会话）
python3 scripts/measure_fps.py --url http://localhost:5176 --scenario both --seconds 4 --theme dark
python3 scripts/measure_fps.py --url http://localhost:5176 --scenario both --seconds 4 --theme light
```

测量方式：页面内 `requestAnimationFrame` 逐帧记录时间戳，统计 3 秒内的帧数、平均 fps、最长帧、以及 >20ms 的帧数。脚本会自动进入对应界面再采样：

- `organize`：进入「整理视图」→ 点「开始整理」，在 HUD 运行态采样
- `detail`：回到「全部照片」→ 双击第一张，在详情打开状态下采样
- `both`：两段依次测

环境要求：示例库 `LIFELOG_HOME=desktop/sample-data`（24 张），并已跑过 `python3 scripts/gen_thumbs.py`。不要在真实相册上跑截图/采样。

## 基线（2026-11-11，Apple M6 / 16GB，headless Chrome 157）

### 主题化玻璃之前（d13fda5 之前）

| 场景 | fps | 采样时长 | 最长帧 | >20ms 帧 |
| --- | ---: | ---: | ---: | ---: |
| 整理视图（整理中） | 60.05 | 3.014s | 16.8ms | 0 |
| 详情打开（含检查器） | 60.52 | 3.007s | 16.8ms | 0 |

### 两套主题（c9c3d43，玻璃只压在照片相关的 5 个面上）

每格是同一配置下 3 次 4 秒采样；fps 三次数值、最长帧取三次里最大。

| 主题 | 场景 | fps（3 次） | 最长帧 | >20ms 帧 |
| --- | --- | --- | ---: | ---: |
| 暗色（烟熏底 30,30,34 / 0.68 / 0.86） | 整理视图 | 60.00 / 60.10 / 60.18 | 16.8ms | 0 / 0 / 0 |
| 暗色 | 详情打开 | 59.93 / 60.23 / 60.28 | 33.4ms | 2 / 0 / 0 |
| 亮色（白雾 255,255,255 / 0.72） | 整理视图 | 60.04 / 60.21 / 60.02 | 16.8ms | 0 / 0 / 0 |
| 亮色 | 详情打开 | 59.63 / 60.26 / 60.37 | 49.9ms | 2 / 0 / 0 |

结论：两种主题的整理视图都稳定 60fps、`>20ms` 全为 0；详情打开稳定在 60fps 附近，只有首次那一轮偶发 1–2 帧超标（见下）。暗/亮之间没有可见成本差，说明当前 glass 参数下 `backdrop-filter` 不是瓶颈，暂时不需要收敛 blur 半径。

## 已知异常：详情首开偶发掉帧

现象：详情场景大约每 4 次采样有 1 次出现 1–2 帧 `>20ms`（观测到 33.4ms 与 49.9ms 各一次），发生在双击打开、1600px 原图首次解码的那一瞬间；同一轮之后的所有帧仍是 16.8ms。

判断：这是图片首帧解码的一次性开销，不是玻璃材质的持续成本——后续 3 次复跑（同配置、同主题）全部为 0 帧超标。

修复（2026-11-11）：详情页不再在换 src 的同一帧里解码，而是把原图挂在可见的 `img` 上、先不淡入，等 `img.decode()` 完成后再显示。修复后 9 次 4 秒采样（暗色）全部 0 帧超标，最长帧回到 16.8ms；双击到面板首帧（17.5/19.5/19.0ms）与到原图首帧（53.1/53.7/54.7ms）与修复前一致，首绘没有被拖慢。

处理约定：报告里保留这条异常，不抹掉；如果以后 `>20ms` 帧不再只在首开出现、而是持续出现，才按回退处理并走「只给详情检查器开 backdrop-filter」的归因 diff。

补充：P1 阶段用同一套方法测过网格连续滚动，60.32fps / 3.017s / 最长帧 16.8ms / >20ms 帧数 0。

16.8ms 是 60Hz 下的单帧上限，说明采样期间没有掉帧；`>20ms 帧数 0` 是硬指标，后续改动如果出现非零就说明有卡顿。

## 改动后怎么对比

1. 同一台机器、同一份示例库、同样的 1440×900 窗口
2. 跑同一条命令，记录两个场景的 fps / 最长帧 / >20ms 帧数
3. 与上表逐项对比；>20ms 帧数由 0 变正，或 fps 低于 58，视为回退

液体玻璃（`backdrop-filter`）是最容易掉帧的一项，建议单独开一次 diff：只在详情检查器上启用，再测 `detail` 场景。

## 整理视图三态（d5b4acf 连续淡入之后）

三态指 待整理（idle）→ 运行中（running）→ 完成（done）。这一版把三态的头部/HUD/完成面板从硬切改成 240ms ease-out 淡入 + 上移 6px，卡片级飞行动画未改。

采样脚本：`scripts/measure_state_transitions.py`（连续记录 rAF，按「点击开始后 800ms」「飞行中」「完成前 800ms」三个窗口切分）

```bash
npm run dev -- --port 5176
python3 scripts/measure_state_transitions.py --url http://localhost:5176
```

3 次结果（暗色，示例库）：

| 窗口 | fps | 最长帧 | >20ms |
| --- | ---: | ---: | ---: |
| 进入 idle→running（0–800ms） | 60.00 / 60.01 / 60.00 | 16.8ms | 0 / 0 / 0 |
| 飞行中 | 60.00 / 60.00 / 60.00 | 16.8ms | 0 / 0 / 0 |
| 完成 running→done（末 1.4s） | 60.00 / 60.00 / 60.01 | 16.8ms | 0 / 0 / 0 |

结论：三态切换没有引入掉帧，和网格基线（60.05fps / 16.8ms / 0）一致。

## 10 万级基准（第一轮，keyset 改造前）

造数：`scripts/make_bench_db.py`，从真实库复制 schema 与词表，生成 100,000 assets / 116,551 captions / 5,784 days / 2,892 events；缩略图与原图用硬链接指向真实库文件，不额外占盘（DB 87.5MB，造数约 21s）。

```bash
python3 scripts/make_bench_db.py --source ~/dev/lifelog-minicpm/data/lifelog.sqlite \
    --rows 100000 --out /tmp/sg-bench-10w
python3 scripts/bench_100k.py --db /tmp/sg-bench-10w/lifelog.sqlite
```

| 场景 | 中位 | 最大 |
| --- | ---: | ---: |
| 首屏 500 条 | 1.0ms | 4.3ms |
| 深翻页 OFFSET 50000 | 244.5ms | 244.5ms |
| 深翻页 OFFSET 95000 | 252.1ms | 252.1ms |
| 搜索 LIKE（6 字段） | 21.1ms | 24.9ms |
| 搜索 count | 70.7ms | 79.5ms |
| 标签精确匹配（高频，11,291 条命中） | 1.2ms | 6.8ms |
| 标签精确匹配（低频，5 条命中） | 81.5ms | 172.1ms |
| person LIKE | 1.7ms | 1.9ms |
| scene = | 1.9ms | 2.0ms |
| facets 全量扫描 | 74.9ms | 75.7ms |
| 时间线按月聚合 | 9.2ms | 9.7ms |

结论：只有深翻页破线。同一份数据换 keyset 游标 `(a.taken_at, a.id) < (?, ?)` 后，offset 50k 从 244.5ms 降到 0.8ms、95k 从 252.1ms 降到 1.1ms，且不随深度劣化。

FTS5 实测结论：LIKE 21ms + count 71ms 在 10 万级仍在预算内，暂不引入（推翻原先「>5000 条就上 FTS5」的预估）。

## 验收脚本的用法（整理视图跨态共享元素）

```bash
npm run dev -- --port 5177
python3 scripts/verify_organize_shared.py --url http://localhost:5177 --out marketing/shots --only main --timeout 120
python3 scripts/verify_organize_shared.py --url http://localhost:5177 --out marketing/shots --only reduced
```

要求 Python >= 3.9（只用标准库）。脚本默认 150s 看门狗：卡住会打印 `[timeout] stuck at stage: <阶段>` 并以退出码 2 结束。rAF 采样带 `setTimeout` 兜底，页面被遮挡时会返回 `ended: "timeout"` 并把 fps 记成 0，不会挂死。

## 10 万级第二轮：补索引 + keyset 翻页

第一轮的数字是在「已经有 `idx_assets_taken`」的基准库上量的，真实库其实没有这条索引。补测后差距很大，这里更正并补上结论。

### 真实库（32,583 条，原本只有 idx_assets_day）

| 场景 | 无索引 | 有索引 |
| --- | ---: | ---: |
| 首屏 500 条 | 74.8ms（最大 304.1ms） | **0.7ms** |
| OFFSET 20000 | 86.6ms | 27.0ms |
| keyset 20000 | — | **1.2ms** |

建索引耗时 10.7ms（32.6k 条）。所以即使只有 3 万张，首屏也从 75ms 降到 1ms 以内。

### 10 万条基准库

| 场景 | 中位 |
| --- | ---: |
| 首屏 500 条 | 1.1ms |
| OFFSET 50000 | 252.3ms |
| OFFSET 95000 | 265.0ms |
| keyset 50000 | **0.9ms** |
| keyset 95000 | **0.8ms** |

### 改动

- `lifelog/db.py`：schema 增加 `idx_assets_taken ON assets(taken_at DESC, day DESC, id DESC)`，`init_db()` 会在下次 CLI 运行时为已有库补建
- `query_assets`：新增可选 `cursor`（`taken_at|day|id`），命中时走 `(a.taken_at, a.day, a.id) < (?, ?, ?)` 并忽略 offset；排序补上 `a.id DESC` 保证严格全序
- 前端 `loadMore` 传上一页最后一条的游标，`taken_at` 缺失时退回 offset
- Rust 单测 `cursor_paging_covers_all_rows_without_duplicates`：1,203 行分 13 页翻完，断言无重复、覆盖全部行

### FTS5 门槛：5k / 50k / 100k 三档

同一套 SQL（最新一条 caption 的子查询 + LIKE 六字段），都有 idx_assets_taken：

| 条数 | 首屏 500 | 搜索 LIKE | 搜索 count | 低频标签 | facets |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 5,000 | 0.9ms | 3.1ms | 3.0ms | 3.1ms | 3.3ms |
| 50,000 | 0.8ms | 30.6ms | 28.9ms | 33.9ms | 36.8ms |
| 100,000 | 0.9ms | 73.1ms | 71.4ms | 82.1ms | 74.9ms |

（搜索/标签这两列是冷页缓存下的首轮数字，热缓存约 20ms。）

结论：LIKE 的劣化是线性的，到 10 万条仍在 100ms 以内；FTS5 还要额外付中文分词与索引维护的代价，不引入。原先「>5000 条就上 FTS5」的预估作废。
