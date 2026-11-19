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


def check(results: dict) -> list[str]:
    """把打印出来的观测值变成断言。没有断言的验收脚本等于没有验收。"""
    problems: list[str] = []

    def must(cond: bool, message: str) -> None:
        if not cond:
            problems.append(message)

    # 1. 无条件时不应有 chip 条
    must(results.get("chips_when_clean") is False, "无条件时不应渲染 chip 条")
    must(results.get("baseline_cells", 0) > 10, f"基线应加载出网格，实际 {results.get('baseline_cells')}")

    # 2. 点标签 → 1 个 chip，且网格变少
    must(len(results.get("after_tag_chips") or []) == 1, "点标签后应恰好 1 个 chip")
    must("风景" in "".join(results.get("after_tag_chips") or []), "chip 文案应含「风景」")
    must(results.get("after_tag_cells", 999) < results.get("baseline_cells", 0), "按标签筛选后网格应变少")
    must(results.get("after_tag_clear_all") is False, "只有 1 个条件时不应出现「清除全部」")

    # 3. 两个条件 → 2 个 chip + 清除全部
    must(len(results.get("after_person_chips") or []) == 2, "两个条件应有 2 个 chip")
    must(results.get("clear_all_visible") is True, "≥2 条件应出现「清除全部」")

    # 4. 移除一个条件 → 只剩 1 个，且网格变多
    must(len(results.get("after_remove_chips") or []) == 1, "移除一个条件后应剩 1 个 chip")
    must("风景" not in "".join(results.get("after_remove_chips") or []), "被移除的条件不应还在")
    must(results.get("cells_grew") is True, "移除条件后网格应变多")

    # 5. 清除全部 → 回到基线
    must(results.get("chips_after_clear_all") is False, "清除全部后 chip 条应消失")
    must(results.get("cells_after_clear_all") == results.get("baseline_cells"),
         f"清除全部后应回到基线 {results.get('baseline_cells')}，实际 {results.get('cells_after_clear_all')}")

    # 6. 搜索 → 关键词 chip；清掉后恢复
    must(any("关键词" in chip for chip in (results.get("search_chips") or [])), "搜索应出现「关键词」chip")
    must(results.get("search_cleared_chip") is False, "清掉关键词后不应再有 chip")
    must(results.get("cells_after_search_clear") == results.get("baseline_cells"),
         "清掉搜索后应回到基线数量")

    # 7. 空结果页的条件 chip 可点，点完回到网格
    must(results.get("empty_results") is True, "搜不到时应显示空结果页")
    must(bool(results.get("empty_conditions")), "空结果页应列出当前条件")
    must(results.get("empty_chip_clickable") is True, "空结果页的条件应可点")
    must(results.get("cells_after_empty_chip", 0) > 0, "点掉空结果条件后应回到网格")
    return problems


def main() -> int:
    profile = tempfile.mkdtemp(prefix="shiguang-filters-")
    chrome = None
    try:
        chrome, cdp = launch(URL, profile)
        time.sleep(2.5)
        result = run(cdp)
        print(json.dumps(result, ensure_ascii=False, indent=1))
        problems = check(result)
        if problems:
            print("FAILED:", file=sys.stderr)
            for item in problems:
                print("  -", item, file=sys.stderr)
            return 1
        print("OK: 断言全部通过")
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
