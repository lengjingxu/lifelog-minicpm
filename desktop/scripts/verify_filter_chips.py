#!/usr/bin/env python3
"""筛选条件 chip 条的 DOM 验收（浏览器 fixture + headless Chrome）。

1 无条件时 .filter-chips 不存在
2 点侧栏「风景」→ 1 个 chip
3 再点「一人」→ 2 个 chip；点第一个 × → 1 个 chip，网格变多
4 ≥2 条件出现「清除全部」；点它后 chip 条消失、网格回到全量
5 搜索词 → 出现「关键词」chip；点 × 后搜索清空、数量恢复
6 空结果：空状态里有可点的条件 chip

依赖 vite dev server（默认 http://localhost:5199）。
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

ROOT = Path(__file__).resolve().parents[1]
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


def cells(cdp) -> int:
    return ev(cdp, "document.querySelectorAll('.cell').length") or 0


def settle(cdp, n=0.7):
    time.sleep(n)


def click_sidebar(cdp, label: str) -> str:
    return ev(
        cdp,
        "(() => { const b=[...document.querySelectorAll('.sidebar button, aside button')]"
        f".find(x=>x.textContent.trim().startsWith({json.dumps(label)}));"
        " if(!b) return 'not-found'; b.click(); return 'ok'; })()",
    )


def run(cdp) -> dict:
    out: dict = {}
    wait_for(cdp, "document.querySelectorAll('.cell').length > 3")
    settle(cdp, 0.8)
    out["baseline_cells"] = cells(cdp)
    out["chips_when_clean"] = ev(cdp, "!!document.querySelector('.filter-chips')")

    # 点侧栏「风景」
    out["tag_click"] = click_sidebar(cdp, "风景")
    settle(cdp, 1.0)
    out["after_tag_cells"] = cells(cdp)
    out["after_tag_chips"] = ev(
        cdp, "[...document.querySelectorAll('.filter-chips .chip')].map(x=>x.textContent.trim())")
    out["after_tag_clear_all"] = ev(cdp, "!!document.querySelector('.filter-chips .clear-all')")

    # 再点「一人」
    out["person_click"] = click_sidebar(cdp, "一人")
    settle(cdp, 1.0)
    out["after_person_cells"] = cells(cdp)
    out["after_person_chips"] = ev(
        cdp, "[...document.querySelectorAll('.filter-chips .chip')].map(x=>x.textContent.trim())")
    out["clear_all_visible"] = ev(cdp, "!!document.querySelector('.filter-chips .clear-all')")

    # 点第一个 chip 的 ×
    ev(cdp, "document.querySelector('.filter-chips .chip button')?.click()")
    settle(cdp, 1.0)
    out["after_remove_cells"] = cells(cdp)
    out["after_remove_chips"] = ev(
        cdp, "[...document.querySelectorAll('.filter-chips .chip')].map(x=>x.textContent.trim())")
    out["cells_grew"] = out["after_remove_cells"] > out["after_person_cells"]

    # 再补一个标签，凑到 2 个条件，再点「清除全部」
    click_sidebar(cdp, "文档票据")
    settle(cdp, 1.0)
    out["before_clear_all_chips"] = ev(
        cdp, "[...document.querySelectorAll('.filter-chips .chip')].map(x=>x.textContent.trim())")
    ev(cdp, "document.querySelector('.filter-chips .clear-all')?.click()")
    settle(cdp, 1.2)
    out["chips_after_clear_all"] = ev(cdp, "!!document.querySelector('.filter-chips')")
    out["cells_after_clear_all"] = cells(cdp)

    # 搜索
    ev(cdp, "(() => { const b=document.querySelector('.search-trigger'); b && b.click(); return !!b; })()")
    wait_for(cdp, "!!document.querySelector('.palette-input input')", 4)
    ev(cdp, """(() => {
      const i=document.querySelector('.palette-input input');
      const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      setter.call(i,'办公室');
      i.dispatchEvent(new Event('input',{bubbles:true}));
      return i.value; })()""")
    settle(cdp, 1.2)
    ev(cdp, "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))")
    ev(cdp, "window.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))")
    settle(cdp, 1.2)
    out["search_chips"] = ev(
        cdp, "[...document.querySelectorAll('.filter-chips .chip')].map(x=>x.textContent.trim())")
    out["search_cells"] = cells(cdp)
    ev(cdp, "document.querySelector('.filter-chips .chip button')?.click()")
    settle(cdp, 1.0)
    out["search_cleared_chip"] = ev(cdp, "!!document.querySelector('.filter-chips')")
    out["search_box_text"] = ev(cdp, "document.querySelector('.search-trigger')?.textContent || ''")
    out["cells_after_search_clear"] = cells(cdp)

    # 空结果：必然搜不到的词
    ev(cdp, "(() => { const b=document.querySelector('.search-trigger'); b && b.click(); return !!b; })()")
    wait_for(cdp, "!!document.querySelector('.palette-input input')", 4)
    ev(cdp, """(() => {
      const i=document.querySelector('.palette-input input');
      const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      setter.call(i,'zzzz-no-such-photo');
      i.dispatchEvent(new Event('input',{bubbles:true}));
      return i.value; })()""")
    settle(cdp, 1.0)
    ev(cdp, "window.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))")
    settle(cdp, 1.4)
    out["empty_results"] = ev(cdp, "!!document.querySelector('.empty-results')")
    out["empty_conditions"] = ev(
        cdp, "[...document.querySelectorAll('.empty-results .empty-conditions .chip')].map(x=>x.textContent.trim())")
    out["empty_chip_clickable"] = ev(
        cdp, "!!document.querySelector('.empty-results .empty-conditions .chip button')")
    # 点空状态里的 chip：应该把关键词去掉、回到网格
    ev(cdp, "document.querySelector('.empty-results .empty-conditions .chip button')?.click()")
    settle(cdp, 1.2)
    out["cells_after_empty_chip"] = cells(cdp)
    return out


def main() -> int:
    profile = tempfile.mkdtemp(prefix="shiguang-filters-")
    chrome = None
    try:
        chrome, cdp = launch(URL, profile)
        time.sleep(2.5)
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
