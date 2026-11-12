# 玻璃材质规范（对齐 glass-folders 参考图）

参考实现：`docs/design/glass-folders.html`（纯 CSS、无图片、无 JS），渲染图 `docs/design/glass-folders-preview.png`。
这份规范只讲材质与层次，不改功能、不改布局骨架。两套主题都要达标。

## 1. 材质参数（照抄，别再自己调一套）

### 亮色面（压在图片/复杂背景上的面板）
| 项 | 值 |
| --- | --- |
| 面板底色 | `rgba(255,255,255,.62)`；**背后有彩色内容时提到 .80**，否则彩色会从面板里透出来变成脏晕 |
| 背景模糊 | `backdrop-filter: blur(18px) saturate(1.35)` |
| 内高光 | `inset 0 1px 0 rgba(255,255,255,.55)` —— 上限 .55，.75 以上会在顶部拉出一条横贯硬线 |
| 内描边 | `inset 0 0 0 1px rgba(255,255,255,.85)` |
| 顶部柔光 | `::after`，高度 46%，`linear-gradient(180deg, rgba(255,255,255,.42), transparent)` |
| 外阴影 | `0 10px 24px rgba(16,16,20,.10)` |
| 容器投影 | `drop-shadow(0 26px 34px rgba(16,16,20,.16)) drop-shadow(0 4px 10px rgba(16,16,20,.08))` |

### 暗色面
| 项 | 值 |
| --- | --- |
| 面板底色 | `rgba(14,14,17,.26)` —— 暗色靠底图出彩，面板要更透 |
| 背景模糊 | `blur(10px) saturate(1.6)`（暗色 blur 比亮色小，颜色更饱） |
| 内高光 / 描边 | `rgba(255,255,255,.10)` 渐变柔光 + `inset 0 0 0 1px rgba(255,255,255,.14)` |

### 暗色底图（关键：渐变必须长在 body 上）
```css
background:
  radial-gradient(110% 95% at 16% 30%, #19f5d8 0%, rgba(25,245,216,0) 52%),
  radial-gradient(95% 85% at 82% 26%, #ff2a4d 0%, rgba(255,42,77,0) 58%),
  radial-gradient(120% 100% at 60% 92%, #0b0b0d 0%, rgba(11,11,13,0) 60%),
  linear-gradient(150deg, #071a1a, #120207 62%, #050506);
```
不要把渐变做成一块独立的圆角矩形叠在面板上方——那样边缘会露一条带子，看起来像“两张卡叠着”。渐变是容器底色，玻璃盖在它上面，整体是一张面。

## 2. 层次结构（从后到前）
1. `tab`：左上角舌片，宽 27%、高 22px，只有上两角圆角
2. `body`：`inset: 20px 0 0 0`，圆角 18px，承载底色/渐变
3. `paper` / `sheets`：夹在 body 与 front 之间，**只露出顶部一条边**
   - 白纸：150×140、`rotate(-1.2deg)`、圆角 8px、`0 8px 18px rgba(16,16,20,.10)`
   - 彩色文件边：5 条，宽 29–57px、高 36px、圆角 2px、`rotate(-8deg…+7deg)`，**每条露出 20px**（实测 19.9–20.4）；宽了圆了就变成“文件夹舌片”
   - 露出的高度要按容器自身的旋转角补偿：容器 `rotate(2.5deg)` 时，靠右的条会因为投影抬高，`top` 要相应减小，否则五条露出的高度会从 9px 到 24px 不等
4. `front`：底部 72% 高的玻璃面板，圆角 20px，`overflow: hidden`
5. 文案：名称 19px/600、日期 11.5px；FAB 38×38、圆角 12px、右下角内缩 14px

## 3. 落到拾光的位置
- `.category-card`（标签/人物/地点卡）：封面 = body，信息条 = front 玻璃面板；卡片外阴影用上面的双层 drop-shadow
- `.group-panel`（整理视图分组）：分组卡 = 文件夹，堆叠照片 = sheets，只露边不露整张
- `.inspector` / `.organize-hud` / `.toast` / 识别弹窗：统一走 `.glass-surface`，参数改成上表；不要再各写一套 blur/alpha
- `.toolbar` / `.sidebar` / `.condition-bar`：底下是纯色，**保持半透明实心，不加 backdrop-filter**（现有注释里的规则不变）

## 4. 验收口径
- 几何：所有子元素 rect 落在父容器内，无溢出；sheets 顶端与 front 顶边差值 18–22px
- 材质：亮色面板背后有彩色内容时，面板内不得出现可辨识的色块晕染（取样面板区域，彩色饱和度不得高于周边背景的 1.2 倍）
- 顶部不得出现横贯 1px 硬线（内高光 ≤ .55）
- 帧率：`python3 scripts/measure_fps.py --scenario both --seconds 4`，两套主题 fps ≥ 58、`>20ms` 帧数为 0；整理三态用 `measure_state_transitions.py`
- `prefers-reduced-transparency: reduce` 时全部退化为实心，不得出现透明穿透


## 三层表面系统（2026-11-12 补）

主人看完截图说「还有很多组件没有对齐最新的玻璃 ui 的设计风格」。原因是之前只把 `.glass-surface` 用在了压在照片上的面（分类卡、整理分组、检查器、toast、徽标、批量条、识别弹窗），其余卡片/控件还是旧的「半透明实心 + 1px 描边」。统一成三层：

| 层 | 用在哪 | 特征 |
| --- | --- | --- |
| `.glass-surface`（已有） | 压在照片/复杂背景上：分类卡前板、整理分组前板、检查器、toast、缩略图徽标、批量条、识别弹窗 | 有 blur，alpha 按亮/暗与是否压照片区分 |
| `.glass-panel`（新增） | 压在应用底色上的卡片容器：设置卡、统计块、导入行、导入占位、分组栏、整理完成面板、登录行、OCR 块、空状态操作卡 | 轻 blur + 上高光 + 外投影 |
| `.glass-control`（新增） | 输入与控件：搜索框、侧栏搜索、分段切换、图标按钮、关闭按钮、ghost 按钮、数字输入、chip、状态胶囊、分组落点、标签按钮、检查器操作按钮 | 不 blur，只有 tint + 上高光 + 描边 |

```css
/* 面板层 */
.settings-card, .stat-box, .import-row, .import-placeholder, .group-rail,
.organize-complete, .login-line, .ocr, .empty-actions > * {
  background: linear-gradient(180deg, rgba(255,255,255,0.055), rgba(255,255,255,0.028));
  -webkit-backdrop-filter: blur(14px) saturate(1.2);
  backdrop-filter: blur(14px) saturate(1.2);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.10), inset 0 0 0 1px rgba(255,255,255,0.08), 0 8px 24px rgba(0,0,0,0.18);
}
[data-theme="light"] .settings-card, [data-theme="light"] .stat-box, [data-theme="light"] .import-row,
[data-theme="light"] .import-placeholder, [data-theme="light"] .group-rail,
[data-theme="light"] .organize-complete, [data-theme="light"] .login-line,
[data-theme="light"] .ocr, [data-theme="light"] .empty-actions > * {
  background: linear-gradient(180deg, rgba(255,255,255,0.92), rgba(255,255,255,0.74));
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.95), inset 0 0 0 1px rgba(23,23,26,0.08), 0 8px 22px rgba(30,30,40,0.10);
}

/* 控件层 */
.search, .sidebar-search, .view-switch, .density-switch, .icon-button,
.close-btn, .ghost-button, .mark-controls input, .mark-controls select,
.chip, .status-pill, .group-target, .tag-cloud button, .inspector-actions button {
  background: rgba(255,255,255,0.045);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.09), inset 0 0 0 1px rgba(255,255,255,0.09);
}
[data-theme="light"] .search, [data-theme="light"] .sidebar-search, [data-theme="light"] .view-switch,
[data-theme="light"] .density-switch, [data-theme="light"] .icon-button, [data-theme="light"] .close-btn,
[data-theme="light"] .ghost-button, [data-theme="light"] .mark-controls input, [data-theme="light"] .mark-controls select,
[data-theme="light"] .chip, [data-theme="light"] .status-pill, [data-theme="light"] .group-target,
[data-theme="light"] .tag-cloud button, [data-theme="light"] .inspector-actions button {
  background: rgba(23,23,26,0.035);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.9), inset 0 0 0 1px rgba(23,23,26,0.10);
}
/* 分段控件的外壳比内部按钮再淡一档 */
.view-switch, .density-switch { background: rgba(255,255,255,0.03); }
[data-theme="light"] .view-switch, [data-theme="light"] .density-switch { background: rgba(23,23,26,0.03); }
```

**不要动**：`.toolbar` / `.sidebar` / `.condition-bar`（底下是纯色，保持半透明实心）；`.cell`（网格性能敏感，只保留徽标玻璃）。

## 一层玻璃（硬规则）

主人原话：「现在页面有大量的一层层的卡片玻璃的重复，一层玻璃套一层。只可以有一层。」

当前实测：详情页 `.overlay-root`（blur 26px）里套了 `.inspector.glass-surface`；识别弹窗里套了统计块/导入行；设置卡里套了登录行；分组栏里套了分组卡——都是两层。

**规则**
1. 一个视觉堆叠里只允许一个元素带 `backdrop-filter`。
2. 容器里如果装着玻璃子元素，容器自己不做玻璃（`.group-rail`、`.organize-complete`、`.overlay-root`）。
3. 玻璃里面的块一律平铺：`background: transparent` + `backdrop-filter: none` + 只留 `inset 0 0 0 1px rgba(255,255,255,.10)` 描边。需要区分层次就靠间距和描边，不要再叠一层底色。

**自检命令**（DevTools Console，返回 `nested: 0` 才算过）
```js
(() => {
  const g = [...document.querySelectorAll('*')].filter(el => {
    const cs = getComputedStyle(el), b = cs.backdropFilter || cs.webkitBackdropFilter;
    return b && b !== 'none';
  });
  const pairs = [];
  for (const x of g) {
    const inner = g.filter(o => o !== x && x.contains(o));
    if (inner.length) pairs.push(x.className + ' > ' + inner.map(o => o.className).join(','));
  }
  return { glass: g.length, nested: pairs.length, pairs };
})()
```

## 详情页：满幅照片 + 悬浮玻璃板

参考图的做法是玻璃压满幅大图，不是把信息栏切成独立一列。

```css
.overlay-root { display: block; padding: 0; backdrop-filter: none; }
.stage { position: absolute; inset: 0; padding: 0; }
.stage-image { height: 100%; }
.inspector {
  position: absolute; right: 24px; top: 24px; bottom: 24px; width: 380px;
  border-radius: 20px; padding: 28px 26px; overflow-y: auto;
  background: linear-gradient(180deg, rgba(14,14,17,0.62), rgba(14,14,17,0.72));
  -webkit-backdrop-filter: blur(24px) saturate(1.4);
  backdrop-filter: blur(24px) saturate(1.4);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.14), inset 0 0 0 1px rgba(255,255,255,0.10), 0 24px 60px rgba(0,0,0,0.45);
}
[data-theme="light"] .inspector {
  background: linear-gradient(180deg, rgba(255,255,255,0.82), rgba(255,255,255,0.70));
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.95), inset 0 0 0 1px rgba(255,255,255,0.6), 0 24px 60px rgba(20,20,30,0.28);
}
```

## 字阶与强调色

- 分类页标题 20 → **30px**，张数数字 **40px / 300 字重**，眉标字距 0.13 → **0.16em**；中间层（11–13px 正文）不动
- 设置标题 23 → **28px**，整理完成标题 22 → **30px**，顶栏标题 15 → **16px**
- 强调色只保留给「选中 / 实时」：`.chip`、`.tag-cloud button`、`.status-pill` 改中性（`rgba(255,255,255,.05)` + `var(--line)` 描边），主按钮和选中态继续用红

## 去分割线：靠留白和底色分层

主人原话：「有很多灰色的划分区域的线条，是不是可以优化去掉，做到整体非常简洁。」

页面现在有 6 条结构性灰线：侧栏右边线、工具栏下边线、侧栏底栏上边线、工具栏竖分隔、详情左栏左边线、检查器操作区上边线。全部去掉，区域靠**底色差 + 留白**区分。

```css
.sidebar { border-right: 0; background: color-mix(in srgb, var(--bg) 55%, transparent); }
.toolbar { border-bottom: 0; }
.sidebar-foot { border-top: 0; padding-top: 16px; }
.toolbar-divider { display: none; }
.inspector { border-left: 0; }
.inspector-actions { border-top: 0; padding-top: 20px; }
.shortcut-row { border-top: 0; }
```

控件与面板也不再画整圈描边：

```css
/* 控件：只靠底色 */
.search, .sidebar-search, .view-switch, .density-switch, .icon-button,
.close-btn, .ghost-button, .mark-controls input, .mark-controls select,
.chip, .status-pill, .group-target, .tag-cloud button, .inspector-actions button { box-shadow: none; }

/* 面板：只留顶部高光 + 外投影 */
.settings-card, .stat-box, .import-row, .import-placeholder,
.organize-complete, .login-line, .ocr, .empty-actions > * {
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.10), 0 8px 24px rgba(0,0,0,0.16);
}

/* 玻璃面：只留顶部高光 + 投影，不要整圈 1px */
.glass-surface {
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.12), 0 18px 44px rgba(0,0,0,0.32);
}
```

**保留的线**（不是分割线，是物件本身）：`kbd` 键帽描边、`:focus-visible` 焦点环、选中态的 2px 强调环、玻璃面的顶部高光。

**验证**（实测，去线后）
- 页面里带 border 的元素从 3 个降到 2 个（剩下的是 ⌘K 键帽）
- 设置卡与页面底色的亮度差：亮色 250.6 vs 239.4，暗色 20.5 vs 11.1 —— 不靠线也能看出卡片边界
