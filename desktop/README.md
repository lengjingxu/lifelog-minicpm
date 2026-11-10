# 拾光 Desktop（macOS 客户端）

本地优先的相册客户端：直接读 `lifelog` 的 SQLite 库，把 AI 打标结果变成可浏览、可检索、可整理的相册。不做云、不做账号。

- 栈：Tauri 2 + React 19 + TypeScript + Vite 8
- 数据：只读 `lifelog.sqlite`；写入一律交给仓库根目录的 Python CLI
- 设计稿与规格：[docs/ui-review.html](docs/ui-review.html) · [docs/PRODUCT-SPEC.md](docs/PRODUCT-SPEC.md)

## 跑起来

```bash
npm install
LIFELOG_HOME="$PWD/sample-data" npm run tauri dev   # 24 张示例库
# 或指向真实库：LIFELOG_HOME=../data npm run tauri dev
```

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
