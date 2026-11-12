# 密度：宽松（全站间距）

主人反馈「整体可以宽松一些」「其他地方的间距也需要宽松」「再松一点，设计感来自空间」。这是全站间距调整，只动 padding / gap / margin / 少量小字号，不动功能、不动配色、不动字体家族。

预览：1440×900，亮色。照片网格 6 列 → 5 列（格子 208px），分类卡 5 列 → 3 列（卡片 ~330px，接近参考图里文件夹的尺度）。

## 1. 采用：宽松二档

主人原话「再松一点，设计感来自空间」。这一档是最终采用值。

```css
/* ===== 采用：宽松二档 ===== */
.app { grid-template-columns: 260px minmax(0, 1fr); }
.sidebar { padding: 0 18px 20px; }
.brand { padding: 6px 12px 22px; gap: 11px; }
.sidebar-search { height: 38px; padding: 0 13px; margin: 0 2px 10px; }
.sidebar-scroll { padding: 6px 2px 196px; }
.nav-group-label { padding: 24px 12px 10px; }
.nav-item { padding: 11px 26px 11px 14px; gap: 11px; font-size: 13.5px; }
.tag-pill { padding: 9px 12px; }
.sidebar-foot { padding: 18px 14px 6px; }

.toolbar { min-height: 72px; padding: 18px 32px 16px 28px; gap: 14px; }
.search { height: 40px; padding: 0 14px; }
.condition-bar { padding: 0 32px 18px; min-height: 46px; gap: 16px; }

.grid-scroll { padding: 24px 32px 56px; }
.timeline-scroll { padding: 0 32px 56px; }
.month-row { gap: 18px; padding: 12px 14px; }
.month-cover { width: 88px; height: 88px; }
.month-header { padding: 22px 1px 14px; }
.timeline-grid { gap: 18px; }

.category-scroll { padding: 44px 44px 64px; }
.category-head { margin: 0 1px 40px; }
.category-grid { grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 26px; }
.category-card .category-front { left: 12px; right: 12px; bottom: 12px; padding: 14px 16px; border-radius: 14px; }
.category-name { font-size: 14px; }
.category-count { font-size: 11.5px; }

.organize-shell { padding: 20px 32px 24px; }
.organize-top { padding: 4px 4px 34px; }
.organize-hud { height: 60px; padding: 11px 14px 11px 18px; margin-bottom: 18px; gap: 24px; }
.group-rail { padding: 18px 18px 14px; }
.group-panels { gap: 16px; }
.group-rail .group-panel { height: 208px; }

.overlay-root { grid-template-columns: minmax(0, 1fr) 380px; }
.stage { padding: 56px 60px; }
.stage-full { padding: 64px 32px 32px; }
.file-name { margin: 0 0 28px; }
.caption { margin: 0 0 28px; line-height: 1.75; }
.meta-grid { gap: 11px 14px; margin: 0 0 28px; }
.tag-cloud { gap: 9px; margin-bottom: 28px; }
.ocr { padding: 14px 15px; }
.inspector-actions { gap: 12px; margin-top: 32px; padding-top: 24px; }
.inspector-actions button { min-height: 40px; }

.settings-scroll { padding: 40px 44px 64px; }
.settings-intro { margin-bottom: 34px; }
.settings-grid { gap: 20px; }
.settings-card { padding: 24px; }
```

## 2. 必须一起改的 JS（否则网格会错位）

```ts
export const GAP = 18;            // 原 10
// gridColumnCount 里：
const minCell = density === "compact" ? 144 : 176;   // 原 132 / 160
const available = viewportWidth - 260 - 64;          // 原 232 - 40
```

`gridColumnCount` 里的 `232` / `40` 是硬编码的侧栏宽和网格左右 padding，**改 CSS 就必须同步改这两个数**，否则列数算错、行高和实际格子对不上。`VirtualGrid` 的 `rowHeight` 用同一个 `GAP` 计算，所以只改常量是自洽的。

## 3. 验收

- 1440 与 1280 两个宽度各截一张：网格列数、分类卡列数、整理分组不重叠
- 10 万级回归：`bench_ui_dev.py --release` 跑一遍，cold/warm/RSS 不能比 555ms / 143ms / 124MB 差；滚动在能拿到前台的机器上补测
- 帧率：`measure_fps.py --scenario both`，暗/亮 fps ≥ 58、`>20ms` 为 0（首开那 1–2 帧属已知异常）
- 详情面板：380px 宽下正文不出现横向滚动条
- 分类卡 3 列时，卡片里的名称/张数不得被截断（最长标签名要能放下）

