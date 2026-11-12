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

## 10 万级第二轮：生成列 + 索引 + keyset 翻页

第一轮的数字是在「已经有 taken_at 索引」的基准库上量的，真实库没有；补测后差距很大，这里更正。

### 真实库（32,583 条）—— 这一行是真实库，不是 bench

| 场景 | 改前 | 改后 |
| --- | ---: | ---: |
| 首屏 500 条 | 74.8ms（最大 304.1ms） | **0.3ms** |
| OFFSET 20000 | 86.6ms | **0.4ms** |
| keyset 20000 | — | **0.3ms** |

lifelog init 给 32.6k 的库补列+建索引耗时 **11.2ms**，第二次运行 0.2ms（幂等）。

### bench 100k（100,000 条）

| 场景 | 中位 | 最大 |
| --- | ---: | ---: |
| 首屏 500 条 | 0.7ms | 0.7ms |
| OFFSET 50000 | 39.8ms | 39.8ms |
| OFFSET 95000 | 40.5ms | 40.5ms |
| keyset 50000 | **0.7ms** | 0.7ms |
| keyset 95000 | **0.7ms** | 0.7ms |
| 搜索 LIKE | 19.4ms | 20.9ms |
| 搜索 count | 70.5ms | 71.0ms |
| person / scene 筛选 | 1.5 / 1.7ms | 1.6 / 1.7ms |
| facets 全量扫描 | 78.0ms | 81.2ms |

### NULL 会静默丢行，所以游标不能直接比较 taken_at

(a.taken_at, a.id) < (?, ?) 是行值比较：任一分量为 NULL 时整体为 NULL，那些行永远不返回；DESC 排序又把 NULL 排在最后，于是翻到末尾会**毫无报错地停住**。

试过两种修法：
1. **表达式索引** CREATE INDEX (COALESCE(taken_at,'') DESC, id DESC) + ORDER BY COALESCE(...)：正确，但带 LEFT JOIN 的查询用不上它，首屏退化到 **128ms**（全排序）。放弃。
2. **虚拟生成列**（采用）：ALTER TABLE assets ADD COLUMN taken_sort TEXT GENERATED ALWAYS AS (COALESCE(taken_at,'')) VIRTUAL，再建索引 idx_assets_cursor ON assets(taken_sort DESC, id DESC)。ORDER BY a.taken_sort DESC, a.id DESC 能直接吃到索引，首屏 0.7ms，NULL 行也能被翻到。

坑：PRAGMA table_info **不返回** VIRTUAL 生成列，必须用 PRAGMA table_xinfo；否则每次 init 都会重复 ALTER 报 duplicate column。

测试覆盖：cursor_paging_never_silently_drops_null_timestamps —— 库里 3 行 taken_at/day 为 NULL，翻完必须覆盖全部行。真实库加 3 行 NULL 后 32,586 行分 11 页全部覆盖。

### 客户端兜底

如果库还没跑过新版 CLI（缺 taken_sort），带游标的请求会直接返回错误「数据库缺少 taken_sort 列，请先运行一次 lifelog CLI 升级索引」，不会静默少行；不带游标的首屏仍可正常打开。
### 口径说明（重要）

上面所有 SQL 数字都是**按 src-tauri/src/lib.rs 里的 SQL 抄出来的副本**、用 Python sqlite3 直接跑的，**不是调用 Rust 的查询构造函数**。
这么做是为了逐条控制变量（索引有无、游标/offset），代价是：IPC 序列化、row->struct 映射、rusqlite 准备语句的开销都不在里面。Rust 侧正确性由 cargo test 保证，端到端延迟用下面的 UI 实测兜底。

## UI 层 10 万级实测（dev 窗口，真实 Tauri WebView）

触发方式（仅 dev）：import.meta.env.DEV 且带 VITE_BENCH=1；生产构建里这段代码被整体剔除（bundle 中 bench 出现次数 0）。

```bash
python3 scripts/bench_ui_dev.py --home /tmp/sg-bench-10w --out /tmp/bench-ui.json
```

| 指标 | 实测 |
| --- | ---: |
| 冷启动到首帧（dev bundle，未优化） | 1605ms |
| 再次打开（切走再切回）p50 | 144ms |
| 搜索 p50（234 命中） | 232ms |
| 搜索 p50（命中 >500，截断到 500） | 68ms / 13ms |
| RSS 峰值 | 319.6MB |
| 滚动 | **18fps，且出现 1 次 3533ms 长帧** |

说明：
- 搜索是**虚拟滚动渲染**（@tanstack/react-virtual，overscan 2），只挂载视口 +/-2 行；命中数不改变挂载量
- 冷启动是 dev bundle，生产构建会明显更快；这条不能当发布指标
- **滚动那 18fps + 一次 3.5s 长帧是待查问题**：单次长任务而不是持续掉帧，怀疑是虚拟列表在滚动中触发了全量 measure 或批量缩略图解码。下一轮定位

## facets 缓存的触发条件（先不动）

facets 冷算 75ms。目前不在每次交互里，只在切视图/刷新时触发一次。
**加缓存的触发条件**：切视图时若出现 >1 帧（16.8ms）的同步阻塞——即 DevTools 里观察到一个 >16.8ms 的 long task 且归因到 facets，再加 5s 内存缓存。
低频标签筛选 p95 为 **172.1ms**（5 条命中的极端 case，扫全表），先接受，记录在此。

## FTS5 结论补充

当初的判断是「单库 >5000 条就把 LIKE 换成 FTS5」。10 万级实测推翻了它：LIKE 在 10 万条仍只要 19.9ms（搜索）/ 70.5ms（count），线性增长且没有拐点。FTS5 还要额外付中文分词、索引维护、查询改写的代价，**不引入**。

## 10 万级已知问题（2026-11-12 定位）

### 1. 进入时间线/标签/人物/地点会一次性拉全量

App.tsx:58 定义 ALL_LIMIT = 100000，第 587 行在 needsAll（时间线/标签/人物/地点/整理）时执行
queryAssets({ limit: ALL_LIMIT })，把整库读进内存。10 万条实测：

| 项 | 数值 |
| --- | ---: |
| 返回行数 | 100,000 |
| SQL 耗时 | 190ms |
| JSON 序列化 | 66ms（Python 侧，Rust 接近） |
| JSON 体积 | **40.8MB** |

WebView 还要把这 40MB 解析成 10 万个对象。实测后果：
- 第 3 次在「标签」和「全部照片」之间切换时，渲染进程直接冻住（连 setTimeout 都不再触发，100s 全局兜底都发不出来）
- RSS 峰值 319-400MB
- 「再次打开」p50 约 2.0s

**修复方向**（未做）：这几个视图要的是聚合结果（按月计数、标签计数、人物计数），应该在 SQL 里 GROUP BY 出结果集，而不是拉全表；时间线还需要按页取缩略图。当前实现是「先全量再前端聚合」，10 万级不可用。

### 2. 时间线视图没有虚拟化

Timeline.tsx 直接 groups.map -> list.map 渲染，10 万条会生成 10 万个格子。上面的全量加载叠加这条，切到时间线基本等于卡死。

### 3. 滚动长帧

bench 在 10 万条下滚 5s 曾出现一次 3533ms 长帧。目前判断与上面第 1 条同源（全量 JSON 解析在滚动期间落地），但还没做隔离验证——bench 现在会记录逐帧 scrollTop/格子数，下次复现可以直接对齐时间点。
