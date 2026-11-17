#!/usr/bin/env python3
"""图库清理键盘通路自测：方向键移焦点、空格/回车切换待清理。

用 Chrome fixture 打开 /?view=space，断言 DOM 与底部结算的文字变化。
运行：python3 scripts/verify_space_keyboard.py
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from measure_fps import CHROME, Cdp, free_port  # noqa: E402

DESKTOP = Path(__file__).resolve().parent.parent


def wait_http(url: str, seconds: float = 20) -> None:
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                if response.status == 200:
                    return
        except Exception:
            time.sleep(0.2)
    raise SystemExit("dev server did not start")


def main() -> int:
    port = free_port()
    server = subprocess.Popen(
        [str(DESKTOP / "node_modules/.bin/vite"), "--port", str(port), "--strictPort", "--host", "127.0.0.1"],
        cwd=DESKTOP, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    chrome = None
    try:
        wait_http("http://127.0.0.1:%d/" % port)
        cdp_port = free_port()
        chrome = subprocess.Popen(
            [CHROME, "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
             "--remote-debugging-port=%d" % cdp_port,
             "--user-data-dir=" + tempfile.mkdtemp(prefix="sg-kbd-"),
             "--window-size=1440,900", "about:blank"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        ws = None
        for _ in range(80):
            try:
                with urllib.request.urlopen("http://127.0.0.1:%d/json/list" % cdp_port, timeout=1) as r:
                    pages = [t for t in json.load(r) if t.get("type") == "page"]
                if pages:
                    ws = pages[0]["webSocketDebuggerUrl"]
                    break
            except Exception:
                pass
            time.sleep(0.25)
        if not ws:
            raise SystemExit("no chrome target")
        cdp = Cdp(ws)
        cdp.call("Page.enable", {})
        cdp.call("Page.navigate", {"url": "http://127.0.0.1:%d/?view=space" % port})
        time.sleep(4)

        def press(key: str, shift: bool = False) -> None:
            cdp.eval(
                "window.dispatchEvent(new KeyboardEvent(\"keydown\", {key: %r, shiftKey: %s, bubbles: true}))"
                % (key, "true" if shift else "false")
            )
            time.sleep(0.25)

        cards = cdp.eval("document.querySelectorAll(\".space-card\").length")
        assert cards > 2, f"网格没有卡片：{cards}"

        # 方向键：第一次 Down 落在第一张，再 Right 到第二张。
        press("ArrowDown")
        first = cdp.eval("document.querySelector(\".space-card.focused\")?.dataset.gridId")
        assert first, "方向键没有把焦点落到卡片上"
        press("ArrowRight")
        second = cdp.eval("document.querySelector(\".space-card.focused\")?.dataset.gridId")
        assert second and second != first, "右方向键没有移动焦点"

        # 空格切换待清理：0 → 1 → 0。
        settle = "document.querySelector(\".space-settlement-copy strong\")?.textContent"
        before = cdp.eval(settle)
        press(" ")
        after = cdp.eval(settle)
        assert before.startswith("0 个") and after.startswith("1 个"), (before, after)
        press(" ")
        assert cdp.eval(settle).startswith("0 个"), "再按一次空格没有移出"

        # 回车同样切换。
        press("Enter")
        assert cdp.eval(settle).startswith("1 个"), "回车没有切换待清理"

        # 焦点在输入框里时不抢键；事件要打在输入框上（真实键击的 target 就是它）。
        cdp.eval("document.querySelector(\".space-filter input\")?.focus()")
        cdp.eval(
            "document.activeElement.dispatchEvent(new KeyboardEvent(\"keydown\", {key: \" \", bubbles: true}))"
        )
        time.sleep(0.3)
        assert cdp.eval(settle).startswith("1 个"), "输入框里按空格误触了切换"

        print("keyboard OK:", {"cards": cards, "first": first, "second": second, "settle": after})
        return 0
    finally:
        if chrome is not None:
            chrome.terminate()
        server.terminate()


if __name__ == "__main__":
    raise SystemExit(main())

