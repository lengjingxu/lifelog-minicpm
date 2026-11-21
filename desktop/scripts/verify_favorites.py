#!/usr/bin/env python3
"""阶段三验收：收藏（浏览器 fixture + headless Chrome）。

fixture 里的收藏只存在内存，用来验证 UI 行为：
1. 网格角落小心形 → 收藏 3 张 → 侧栏计数 = 3
2. 点侧栏「收藏」→ 只显示这 3 张
3. 取消收藏 1 张 → 计数 = 2
4. 详情页心形可切换（aria-pressed 变化）
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from measure_fps import CHROME, Cdp, free_port  # noqa: E402

URL = "http://localhost:5199/?theme=dark"


def launch(url: str, profile: str):
    port = free_port()
    chrome = subprocess.Popen(
        [CHROME, "--headless=new", "--disable-gpu", f"--remote-debugging-port={port}",
         f"--user-data-dir={profile}", "--window-size=1500,940", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    ws = None
    for _ in range(80):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=1) as resp:
                pages = [t for t in json.load(resp) if t.get("type") == "page"]
            if pages:
                ws = pages[0]["webSocketDebuggerUrl"]
                break
        except Exception:
            pass
        time.sleep(0.25)
    if not ws:
        raise SystemExit("cdp 不可用")
    cdp = Cdp(ws)
    cdp.call("Page.navigate", {"url": url})
    return chrome, cdp


def ev(cdp, expr, await_promise=False):
    return cdp.eval(expr, await_promise=await_promise)


def wait_for(cdp, expr, timeout=8.0):
    end = time.time() + timeout
    while time.time() < end:
        if ev(cdp, expr):
            return True
        time.sleep(0.1)
    return False


def sidebar_count(cdp, label: str):
    return ev(
        cdp,
        "(() => { const b=[...document.querySelectorAll('.nav-item')]"
        f".find(x=>x.textContent.includes({json.dumps(label)}));"
        " return b ? (b.querySelector('.count')?.textContent || '') : 'missing'; })()",
    )


def run(cdp) -> dict:
    out: dict = {}
    wait_for(cdp, "document.querySelectorAll('.cell').length > 3")
    time.sleep(0.8)
    out["cells_before"] = ev(cdp, "document.querySelectorAll('.cell').length")

    # 收藏前 3 张：p4 挂到卡片右上角，pointer-events 默认 opacity 0，但可以直接 click
    out["favorite_clicked"] = ev(
        cdp,
        "(() => { const hearts=[...document.querySelectorAll('.cell-favorite')].slice(0,3);"
        " hearts.forEach(h=>h.click()); return hearts.length; })()",
    )
    time.sleep(1.0)
    out["sidebar_after_add"] = sidebar_count(cdp, "收藏")
    out["toast"] = ev(cdp, "document.querySelector('.toast')?.textContent || ''")

    # 点侧栏「收藏」
    ev(
        cdp,
        "(() => { const b=[...document.querySelectorAll('.nav-item')]"
        ".find(x=>x.textContent.includes('收藏')); b && b.click(); return !!b; })()",
    )
    time.sleep(1.2)
    out["filtered_cells"] = ev(cdp, "document.querySelectorAll('.cell').length")
    out["chips"] = ev(
        cdp, "[...document.querySelectorAll('.filter-chips .chip')].map(x=>x.textContent.trim())")
    out["active_nav"] = ev(
        cdp, "document.querySelector('.nav-item.active')?.textContent?.trim() || ''")

    # 取消收藏一张：点第一张的心形
    ev(cdp, "document.querySelector('.cell-favorite')?.click()")
    time.sleep(1.0)
    out["sidebar_after_remove"] = sidebar_count(cdp, "收藏")
    out["filtered_after_remove"] = ev(cdp, "document.querySelectorAll('.cell').length")

    # 详情页心形：先退出「收藏」筛选，避免取消后被筛掉的卡片连详情一起消失
    ev(
        cdp,
        "(() => { const b=[...document.querySelectorAll('.nav-item')]"
        ".find(x=>x.textContent.includes('收藏')); b && b.click(); return !!b; })()",
    )
    time.sleep(1.0)
    ev(cdp, "document.querySelector('.cell')?.click()")
    wait_for(cdp, "!!document.querySelector('.inspector-favorite')", 6)
    out["detail_favorite_present"] = ev(cdp, "!!document.querySelector('.inspector-favorite')")
    before = ev(cdp, "document.querySelector('.inspector-favorite')?.getAttribute('aria-pressed')")
    ev(cdp, "document.querySelector('.inspector-favorite')?.click()")
    time.sleep(0.8)
    after = ev(cdp, "document.querySelector('.inspector-favorite')?.getAttribute('aria-pressed')")
    out["detail_toggle"] = {"before": before, "after": after}
    out["detail_actions"] = ev(cdp, "document.querySelector('.inspector-actions')?.innerText || ''")
    out["errors"] = ev(cdp, "window.__errs || []")
    return out


def main() -> int:
    profile = tempfile.mkdtemp(prefix="shiguang-fav-")
    chrome = None
    try:
        chrome, cdp = launch(URL, profile)
        time.sleep(2.5)
        ev(cdp, "window.__errs=[];window.addEventListener('error',e=>window.__errs.push(String(e.message)))")
        result = run(cdp)
        print(json.dumps(result, ensure_ascii=False, indent=1))
        ok = (
            result["favorite_clicked"] == 3
            and result["sidebar_after_add"] == "3"
            and result["filtered_cells"] == 3
            and result["sidebar_after_remove"] == "2"
            and result["filtered_after_remove"] == 2
            and result["detail_favorite_present"]
            and result["detail_toggle"]["before"] != result["detail_toggle"]["after"]
            and not result["errors"]
        )
        return 0 if ok else 1
    finally:
        if chrome is not None:
            chrome.terminate()
            try:
                chrome.wait(timeout=5)
            except subprocess.TimeoutExpired:
                chrome.kill()
        shutil.rmtree(profile, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
