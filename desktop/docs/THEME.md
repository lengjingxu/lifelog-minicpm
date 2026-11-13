# 主题令牌（theme.css）

所有「主题性质」的配置都在 `desktop/src/theme.css`，组件样式 `styles.css` 只引用 `var()`。
换肤、调节奏、改质感，只动这一个文件。

## 文件分工

| 文件 | 放什么 |
| --- | --- |
| `src/theme.css` | 颜色、玻璃材质、透明度、圆角、间距、字号、模糊、动效曲线与时长 |
| `src/styles.css` | 组件规则，只写 `var(--token)`，不写具体 px / rgba |

`main.tsx` 里先 import `theme.css` 再 import `styles.css`。

## 令牌命名：名字就是原值

| 类别 | 前缀 | 例子 |
| --- | --- | --- |
| 间距 | `--space-` | `--space-12: 12px` |
| 圆角 | `--radius-` | `--radius-9: 9px`、`--radius-999: 999px` |
| 字号 | `--font-` | `--font-12-5: 12.5px`（小数点写成 `-`） |
| 透明度 | `--alpha-` | `--alpha-0-08: 0.08` |
| 模糊 | `--blur-` | `--blur-18: 18px` |
| 颜色 / 玻璃 / 动效 | 语义名 | `--text-dim`、`--glass-bg`、`--ease-out` |

名字带原值是为了「拆出来时渲染零变化」。要收敛成 4px 栅格，直接改 theme.css 里的数值即可，组件不用动。

## 规则

1. 组件样式里不写 px 的 padding / margin / gap / border-radius / font-size，也不写字面量 `rgba(..., 0.xx)`。
2. 需要新尺寸时先在 `theme.css` 加令牌，再在组件里引用。
3. 宽度、高度、定位偏移属于布局，不进主题；阴影的偏移量也不进，只把颜色透明度 token 化。
4. 亮/暗两套只在 `theme.css` 里分块，组件不写 `[data-theme]` 分支（除非是材质差异，比如玻璃）。

## 怎么验证改动没把界面弄坏

改完跑一次 computed style 对比：同一个页面在改动前后逐元素比对 `font-size / border-radius / padding / gap / background-color / backdrop-filter / box-shadow / color`。

本次拆分的实测：**8 个视图（亮/暗 × 图库/分类/设置/详情）、2600 个元素，差异 0**。

脚本思路（headless Chrome + CDP）：注入 1440×900，遍历 `body *`，`getComputedStyle` 取上述属性，前后各存一份 JSON 做 diff。

