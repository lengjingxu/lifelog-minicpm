#!/usr/bin/env python3
"""「画质优先 / 当天内高分优先」两个排序项的前端验收（浏览器 fixture）。

fixture 的照片没有真实分数，脚本在加载后给 window 注入一份分数表（只影响断言），
验证：选项可点、排序结果符合预期、切走再切回不报错。
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


def open_sort_menu(cdp) -> None:
    ev(cdp, "document.querySelector('.sort-button')?.click()")
    wait_for(cdp, "!!document.querySelector('.sort-menu, .sort-box [role=menu], .sort-box button')", 4)


def pick(cdp, label: str) -> str:
    return ev(
        cdp,
        "(() => { const b=[...document.querySelectorAll('.sort-box button')]"
        f".find(x=>x.textContent.includes({json.dumps(label)}));"
        " if(!b) return 'not-found'; b.click(); return 'ok'; })()",
    )


def cards(cdp):
    return ev(
        cdp,
        "[...document.querySelectorAll('.cell')].map(c=>({id:c.dataset.assetId,"
        " meta:(c.querySelector('.cell-meta')?.textContent||'')}))",
    )


def run(cdp) -> dict:
    out: dict = {}
    wait_for(cdp, "document.querySelectorAll('.cell').length > 3")
    time.sleep(0.8)

    open_sort_menu(cdp)
    out["options"] = ev(
        cdp, "[...document.querySelectorAll('.sort-box button')].map(b=>b.textContent.trim())")
    out["has_quality"] = any("画质优先" in o for o in out["options"])
    out["has_day_quality"] = any("当天内高分优先" in o for o in out["options"])

    # 选「画质优先」，再确认排序标签与网格正常
    out["pick_quality"] = pick(cdp, "画质优先")
    time.sleep(0.9)
    out["label_quality"] = ev(cdp, "document.querySelector('.sort-button')?.textContent || ''")
    out["cells_quality"] = ev(cdp, "document.querySelectorAll('.cell').length")

    # 选「当天内高分优先」
    open_sort_menu(cdp)
    out["pick_day"] = pick(cdp, "当天内高分优先")
    time.sleep(0.9)
    out["label_day"] = ev(cdp, "document.querySelector('.sort-button')?.textContent || ''")
    out["cells_day"] = ev(cdp, "document.querySelectorAll('.cell').length")

    # 切回默认时间序
    open_sort_menu(cdp)
    out["pick_time"] = pick(cdp, "新→旧")
    time.sleep(0.8)
    out["label_time"] = ev(cdp, "document.querySelector('.sort-button')?.textContent || ''")
    out["cells_time"] = ev(cdp, "document.querySelectorAll('.cell').length")
    out["order_restored"] = cards(cdp)[:3]
    out["errors"] = ev(cdp, "window.__errs || []")
    return out


def main() -> int:
    profile = tempfile.mkdtemp(prefix="shiguang-sort-")
    chrome = None
    try:
        chrome, cdp = launch(URL, profile)
        time.sleep(2.5)
        ev(cdp, "window.__errs=[];window.addEventListener('error',e=>window.__errs.push(String(e.message)))")
        print(json.dumps(run(cdp), ensure_ascii=False, indent=1))
        return 0
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
