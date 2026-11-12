# 密度：宽松一档（全站间距）

主人反馈「整体可以宽松一些」「其他地方的间距也需要宽松」。这是全站间距的一档调整，只动 padding / gap / margin / 少量小字号，不动功能、不动配色、不动字体家族。

预览：1440×900，亮色；照片网格 6 列不变（列宽变大），分类卡 5 列 → 4 列。

## 1. 直接可用的 CSS

追加到 `src/styles.css` 末尾（或按选择器并回原处）：

```css
.app { grid-template-columns: 244px minmax(0, 1fr); }
.sidebar { padding: 0 14px 16px; }
.brand { padding: 4px 10px 18px; gap: 10px; }
.sidebar-search { height: 34px; padding: 0 11px; margin: 0 2px 6px; }
.sidebar-scroll { padding: 4px 2px 184px; }
.nav-group-label { padding: 19px 10px 8px; }
.nav-item { padding: 9px 24px 9px 12px; gap: 10px; }
.tag-pill { padding: 7px 11px; }
.sidebar-foot { padding: 14px 12px 4px; }

.toolbar { min-height: 64px; padding: 14px 24px 12px 22px; gap: 12px; }
.search { height: 36px; padding: 0 12px; }
.condition-bar { padding: 0 24px 14px; min-height: 40px; gap: 14px; }

.grid-scroll { padding: 16px 24px 40px; }
.timeline-scroll { padding: 0 24px 44px; }
.month-row { gap: 14px; padding: 10px 12px; }
.month-cover { width: 80px; height: 80px; }
.month-header { padding: 18px 1px 12px; }
.timeline-grid { gap: 14px; }

.category-scroll { padding: 34px 34px 48px; }
.category-head { margin: 0 1px 32px; }
.category-grid { grid-template-columns: repeat(auto-fill, minmax(248px, 1fr)); gap: 20px; }
.category-card .category-front { left: 10px; right: 10px; bottom: 10px; padding: 12px 14px; border-radius: 13px; }
.category-name { font-size: 13.5px; }
.category-count { font-size: 11px; }

.organize-shell { padding: 16px 24px 18px; }
.organize-top { padding: 2px 2px 26px; }
.organize-hud { height: 54px; padding: 9px 12px 9px 16px; margin-bottom: 14px; gap: 20px; }
.group-rail { padding: 14px 14px 10px; }
.group-panels { gap: 12px; }
.group-rail .group-panel { height: 192px; }

.overlay-root { grid-template-columns: minmax(0, 1fr) 360px; }
.stage { padding: 48px 52px; }
.stage-full { padding: 56px 26px 28px; }
.file-name { margin: 0 0 24px; }
.caption { margin: 0 0 24px; line-height: 1.72; }
.meta-grid { gap: 9px 12px; margin: 0 0 24px; }
.tag-cloud { gap: 8px; margin-bottom: 24px; }
.ocr { padding: 12px 13px; }
.inspector-actions { gap: 10px; margin-top: 28px; padding-top: 20px; }
.inspector-actions button { min-height: 36px; }

.settings-scroll { padding: 32px 36px 52px; }
.settings-intro { margin-bottom: 26px; }
.settings-grid { gap: 15px; }
.settings-card { padding: 20px; }
```

## 2. 必须一起改的 JS（否则网格会错位）

`src/utils.ts`：

```ts
export const GAP = 14;            // 原 10

export function gridColumnCount(viewportWidth: number, density: "comfort" | "compact"): number {
  const requested = density === "compact" ? 8 : 6;
  const minCell = density === "compact" ? 132 : 160;
  const available = viewportWidth - 244 - 48;   // 原 232 - 40，跟着侧栏宽和 .grid-scroll 左右 padding 走
  ...
}
```

`gridColumnCount` 里的 `232` 和 `40` 是硬编码的侧栏宽和网格左右 padding，**改 CSS 就必须同步改这两个数**，否则列数算错、行高和实际格子对不上。`VirtualGrid` 的 `rowHeight` 用同一个 `GAP` 计算，所以只改常量是自洽的。

## 3. 验收

- 1440 与 1280 两个宽度各截一张：网格列数、分类卡列数、整理分组不重叠
- 10 万级回归：`bench_ui_dev.py --release` 跑一遍，cold/warm/RSS 不能比 555ms / 143ms / 124MB 差；滚动在能拿到前台的机器上补测
- 帧率：`measure_fps.py --scenario both`，暗/亮 fps ≥ 58、`>20ms` 为 0（首开那 1–2 帧属已知异常）
- 详情面板：360px 宽下正文不出现横向滚动条

