# 评审：批量移除标签 / 移出相册

- 分支：`feat/remove-entry`
- 提交：`4fd158a`
- 评审人：LiZi（2026-11-11）
- 结论：**功能正确，但有 1 个必须先修的语义漏洞；修完即可合并**

消息通道当时不可用（`PERMISSION_DENIED`），所以评审写在这里，拉代码即可看到。

## 已核通过

| 项 | 结果 |
|---|---|
| `npm run build` | 产物 `index-DUJU2tHG.js` 343.41 kB，与提交者报的一致 |
| `cargo check` | 通过（`Finished dev profile`） |
| 撤销原子性 | `revert()` 用同一批 ids 调一次 `bulkTag(..., false)` / `albumAdd(..., false)`，后端一次事务完成 |
| 5 秒窗口 / 不叠 toast | `action ? 5000 : 2400`；新操作直接覆盖 `pendingUndo.current` |
| 只删关联 | 无 `lifelog/`、`src-tauri/` 改动，复用既有 `--remove` 路径；不碰 `captions`、不碰文件 |
| 空相册保留 | 只删 `album_assets` 行，`albums` 行不动 |
| 计数同步 | `refreshData()` 重拉 facets + `dataVersion` 触发重查 |
| 截图 | 19 → 16 → 19，侧边栏计数同步，toast 带撤销 |

## 阻塞：AI 标签的「移除」是假成功

入口条件是 `tags.length === 1`，任何单标签筛选都会出现按钮，**包括 AI 标签**（室内居家、文档票据…）。但移除只删 `asset_tags`（用户标签），`captions.tags` 里的 AI 标签删不掉。

真实后果：AI 标签下点移除 → 后端 0 行受影响 → 界面提示「已从 3 张移除标签」→ 刷新后照片仍在。fixture 模式用 `localRemoved` 覆盖层模拟，掩盖了这个断层。

### 改法（选一，推荐 A）

**A. 入口只对用户标签出现**

- 后端 `facets()` 增加区分来源的信息，例如 `tags: [[name, count, isUser]]`，或单独返回 `user_tags: [[name, count]]`
- 前端只有 `isUser` 的标签才显示「移除此标签」按钮；AI 标签不显示

**B. 若要支持隐藏 AI 标签**

那是另一套语义：在 `asset_tags` 写一条 `hidden` 记录（或新表 `hidden_tags`），查询时排除。不能复用删除。本轮不建议做。

### 验收（修完后自检）

1. 在 AI 标签筛选下选中照片：**不出现**「移除此标签」
2. 在用户标签下移除：`sqlite3 <home>/lifelog.sqlite "select count(*) from asset_tags where tag='X'"` 必须真的减少，刷新后照片消失
3. 撤销后同一查询恢复原值
4. 相册路径不变：`album_assets` 减少、`albums` 保留

## 两条小问题（不阻塞合并）

1. `fixtureAlbums` 建议加 `import.meta.env.DEV &&` 双保险，避免以后被当成真实数据源
2. 撤销后网格会有一瞬空白格（截图可见），建议保留上一帧占位，别让格子塌掉

## 顺带确认的一个真问题

`desktop/package-lock.json` 缺 `@tauri-apps/plugin-dialog`（`package.json` 有、锁文件没有）：`main` 锁文件 0 处，本分支 3 处。这是「`npm ci` 后找不到模块」的成因之一——`npm ci` 严格按锁文件装，而 `bun install` 按 package.json 解析，所以之前只有 bun 能救。已在本分支修复，合并后应写进 README 的排查段落。

## 合并策略

PR 创建被 GitHub 429 挡住时：修完推同一分支，我按增量评审，通过后本地 `merge --no-ff` 并在提交信息里注明「无 PR，因 429」。
