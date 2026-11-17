# 图库清理键盘自测

运行：`python3 scripts/verify_space_keyboard.py`（脚本自己起 vite + headless Chrome）。

断言：

1. 方向键把焦点落到网格卡片（`ArrowDown` 选第一张，`ArrowRight` 移到第二张）。
2. 空格切换待清理：底部结算从 `0 个` → `1 个` → 再按一次回 `0 个`。
3. 回车同样切换。
4. 焦点在路径筛选输入框里时按空格不会切换待清理。

最近一次运行输出：

```
keyboard OK: {'cards': 12, 'first': '7732bd48945b25cd', 'second': 'e1093ef6eeba5dd3', 'settle': '1 个 · 516 KB'}
```
