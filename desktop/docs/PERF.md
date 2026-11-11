# 性能基线 · 帧率

桌面端现在的动画基线，用来对比后续 UI 改动（主题切换、液态玻璃、连续动效）有没有掉帧。

## 怎么测

脚本：`scripts/measure_fps.py`（只用标准库，自带 headless Chrome + CDP）

```bash
# 先在另一个终端起 dev server（浏览器 fixture 模式，不依赖 Tauri）
npm run dev -- --port 5176

# 再跑采样
python3 scripts/measure_fps.py --url http://localhost:5176 --scenario both --seconds 3
```

测量方式：页面内 `requestAnimationFrame` 逐帧记录时间戳，统计 3 秒内的帧数、平均 fps、最长帧、以及 >20ms 的帧数。脚本会自动进入对应界面再采样：

- `organize`：进入「整理视图」→ 点「开始整理」，在 HUD 运行态采样
- `detail`：回到「全部照片」→ 双击第一张，在详情打开状态下采样
- `both`：两段依次测

环境要求：示例库 `LIFELOG_HOME=desktop/sample-data`（24 张），并已跑过 `python3 scripts/gen_thumbs.py`。不要在真实相册上跑截图/采样。

## 基线（2026-11-11，Apple M6 / 16GB，headless Chrome 157）

| 场景 | fps | 采样时长 | 最长帧 | >20ms 帧 |
| --- | ---: | ---: | ---: | ---: |
| 整理视图（整理中） | 60.05 | 3.014s | 16.8ms | 0 |
| 详情打开（含检查器） | 60.52 | 3.007s | 16.8ms | 0 |

补充：P1 阶段用同一套方法测过网格连续滚动，60.32fps / 3.017s / 最长帧 16.8ms / >20ms 帧数 0。

16.8ms 是 60Hz 下的单帧上限，说明采样期间没有掉帧；`>20ms 帧数 0` 是硬指标，后续改动如果出现非零就说明有卡顿。

## 改动后怎么对比

1. 同一台机器、同一份示例库、同样的 1440×900 窗口
2. 跑同一条命令，记录两个场景的 fps / 最长帧 / >20ms 帧数
3. 与上表逐项对比；>20ms 帧数由 0 变正，或 fps 低于 58，视为回退

液体玻璃（`backdrop-filter`）是最容易掉帧的一项，建议单独开一次 diff：只在详情检查器上启用，再测 `detail` 场景。

