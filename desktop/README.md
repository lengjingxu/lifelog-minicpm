# 拾光 Desktop（macOS 客户端）

本地优先的相册客户端：直接读 `lifelog` 的 SQLite 库，把 AI 打标结果变成可浏览、可检索、可整理的相册。不做云、不做账号。

- 栈：Tauri 2 + React 19 + TypeScript + Vite 8
- 数据：只读 `lifelog.sqlite`；写入一律交给仓库根目录的 Python CLI
- 设计稿与规格：[docs/ui-review.html](docs/ui-review.html) · [docs/PRODUCT-SPEC.md](docs/PRODUCT-SPEC.md)
- 性能与基准：[docs/PERF.md](docs/PERF.md)（帧率） · [docs/THUMBS.md](docs/THUMBS.md)（缩略图管线）

## 跑起来

```bash
npm ci
python3 scripts/gen_thumbs.py                        # 生成 thumbs/{id}.jpg (360px) 与 thumbs/full/{id}.jpg (1600px)
LIFELOG_HOME="$PWD/sample-data" npm run tauri dev   # 24 张示例库
# 或指向真实库：LIFELOG_HOME=../data npm run tauri dev
```

**顺序不能省**：缩略图产物不入库（见 `.gitignore`），全新克隆里 `thumbs/full/` 是空的。跳过 `gen_thumbs.py` 时详情页会回落到 `photos/` 原图——示例库还看不出来，真库里的 HEIC/RAW 会明显变慢，容易被误判成性能问题。

`gen_thumbs.py` 默认处理 `desktop/sample-data`，也接受 `--home` 或 `LIFELOG_HOME` 指向别的库；已存在的图会跳过，可反复增量跑。

Rust 首次编译约 3–5 分钟。构建产物：`npm run tauri build`。

## 目录

```
src/             React 前端（网格 / 详情 / 搜索）
src-tauri/       Rust：只读 SQLite + IPC command
docs/            规格、UI 稿、评审页
sample-data/     24 张示例照片 + 真实 AI 描述 + 缩略图
```

## 与主仓库的关系

识别、导入、打标都在仓库根目录的 Python 侧：`lifelog/sync_xiaomi.py`、`lifelog/caption.py`、`lifelog/recognize.py`。
桌面端不重写这些，只负责：读库展示、消费 `/api/live/*` 事件流做「整理视图」、把长任务状态显示出来。

## 浏览器预览（无 Tauri）

```bash
python3 scripts/export_fixture.py   # public/sample-fixture.json
npm run dev
```

`src/api.ts` 会按 `window.__TAURI_INTERNALS__` 自动切换：Tauri 里走 `invoke` + asset protocol，浏览器里读同一份 fixture，图片由 Vite 的 `/__fixture/*` 中间件映射到 `sample-data/`。界面组件只有一套。

## 技术待办

- **FTS5**：当前搜索用 SQL `LIKE`，示例库 24 条、真实库 239 条下足够快。单库超过 5000 条时再上 FTS5 虚表（覆盖 `caption / tags / scene / place / ocr_text`，`content=sync` 跟随主表），现在不建。

## 装不上或构建报缺类型时

本机反复出现过 `npm ci` 之后 `node_modules` 不完整的情况（`react`、`lucide-react` 的 `.d.ts`、`vite/package.json` 时有时无），表现为 `tsc` 报 `TS2307` / `TS7016`，重跑 `npm run build` 有时又能过。

```bash
rm -rf node_modules && bun install   # 用 bun 的安装器，一次就正常
```

这不是代码问题，换一台机器不一定复现；但遇到「明明装了却找不到模块」，先按上面重装，不要先去改 `tsconfig`。
