# 交接说明（2026-11-11）

开发权交回 mini。从现在起：**代码由 mini 写，LiZi 只做验收、测量协调和文档**。

## 当前状态

- `main = 4bdbe8e`，工作区干净，无开放 PR
- 客户端：P0/P1/P2 全在；主题、玻璃、动效三层改造完成；缩略图管线、导入入口、批量标签/相册都已接上
- 性能基线（mini 实测）：网格 60.05fps / 详情 60.52fps / 整理三态 60.00fps，最长帧 16.8ms，>20ms 全 0

## LiZi 这批改了什么（接手时重点看这些文件）

| 范围 | 文件 | 提交 |
|---|---|---|
| 主题 / 玻璃 / 动效 token | `src/styles.css`、`src/motion.ts`、`src/components/Topbar.tsx` | `6f19e94` `baa54a8` `24d9e1d` `bd24cef` |
| 连续动效 | `App.tsx`、`VirtualGrid.tsx`、`Thumb.tsx`、`Detail.tsx`、`Sidebar.tsx`、`OrganizeView.tsx`、`RecognitionDialog.tsx` | `6f19e94` `d5b4acf` `24d9e1d` |
| 缩略图管线 | `scripts/gen_thumbs.py`、`src-tauri/src/lib.rs`、`SettingsView.tsx` | `922d112` `f0e1b3f` `b9c1ac9` |
| 导入入口 | `src-tauri/src/lib.rs`（`import_folder`）、`api.ts`、`App.tsx`、`Cargo.toml`（dialog 插件） | `e8de737` |
| 批量标签/相册 | `lifelog/ops.py`、`lifelog/cli.py`、`SelectionBar.tsx`、`Sidebar.tsx`、`App.tsx` | `f05180f` `4bdbe8e` |

## 待办（按建议顺序）

1. **移除入口**：批量移除标签、从相册移除。CLI 已有 `tag-remove` / `album-remove`，只缺 UI
2. **导出**：选中照片导出到指定目录（含原图与 AI 描述）
3. **删除**：需先定义语义——删库记录（可重建）/ 删磁盘文件（不可逆）。建议只做前者并明确提示
4. **小米云导入**：现在空状态的「导入小米相册」仍是 toast；需要 token 登录态与错误处理
5. **整理视图跨态共享元素**：堆里那张卡本身变成分组卡（目前只做了容器淡入）
6. **10 万级性能验证**、签名/公证/DMG、最小 CI
7. A7 边缘折射（WebGL），押后，需先有帧率对照组

## 已知坑（别重复踩）

- **npm 装包**：本机 `npm ci` 会间歇性缺文件（`react`、`lucide-react` 的 `.d.ts`、`vite/package.json`），构建偶发 `TS2307/TS7016`。用 `bun install` 重装可解决，已写进 `desktop/README.md`
- **PR 创建**：GitHub 曾连续 429（`submitted too quickly`），那几次是本地 merge 后直推 main；正常情况请走 PR
- **sample-data**：24 张示例库，改动要连带重跑 `scripts/export_fixture.py`，不要只改一半
- **HEIC**：走「先 1600 再缩 360」，360 不是逐字节一致（1–2% Y），已在 `THUMBS.md` 说明，不要当 bug
- **坏文件**：`thumbs/broken.json` 记录已知坏件，默认跳过，`--retry-broken` 才重试

## 验证命令

```bash
cd desktop
bun install && npm run build          # 前端
cd src-tauri && cargo check           # Rust
python3 scripts/measure_fps.py --url http://localhost:5176 --scenario both --theme dark
python3 scripts/measure_state_transitions.py --url http://localhost:5176
```

## 协作约定

- 同一时间只有一个人改代码；当前是 mini
- mini 改完开 PR，LiZi review（不再直推 main）
- 需要新的测量基线时，LiZi 提，mini 跑
