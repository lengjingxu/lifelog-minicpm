#!/usr/bin/env python3
"""三条验收的 DOM 断言（浏览器 fixture + headless Chrome）。

1 选中 3 张 → 没有 input.selection-input，加标签/加入相册可点
2 加入相册 → 面板 → 选已有相册 → 文案「已把 3 张加入相册『X』」
3 加标签 → 面板列已有标签 → 点一个 → 文案「已给 3 张加标签」
4 详情页：inspector-actions 不含删除；顶部 [aria-label=删除这一张]；点击弹确认
5 缩略图常显信息条；紧凑密度只显示日期

依赖 vite dev server（默认 http://localhost:5199）和一个真实库的 tag 源：
fixture 里 tags 用 facets.tags 补成 user_tags（只在这个脚本运行期间写入，结束恢复）。
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
FIXTURE = ROOT / "public" / "sample-fixture.json"
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


def wait_text(cdp, text, timeout=6.0):
    return wait_for(cdp, f"(document.body.innerText||'').includes({json.dumps(text)})", timeout)


def run(cdp) -> dict:
    out: dict = {}
    # 先等网格
    out["grid"] = wait_for(cdp, "document.querySelectorAll('.cell').length > 3")
    time.sleep(0.6)

    # 常显信息条
    out["meta_text"] = ev(cdp, "document.querySelector('.cell .cell-meta')?.textContent || ''")
    out["meta_opacity"] = ev(
        cdp,
        "(() => { const m=document.querySelector('.cell .cell-meta'); if(!m) return 0;"
        " return Number(getComputedStyle(m).opacity); })()",
    )
    out["overlay_opacity_default"] = ev(
        cdp,
        "(() => { const o=document.querySelector('.cell .overlay'); if(!o) return 0;"
        " return Number(getComputedStyle(o).opacity); })()",
    )

    # 选 3 张（按住 meta 点）
    ev(
        cdp,
        """(() => {
        const cells=[...document.querySelectorAll('.cell')].slice(0,3);
        cells.forEach((c,i)=>c.dispatchEvent(new MouseEvent('click',{bubbles:true,metaKey:true})));
        return cells.length; })()""",
    )
    out["selection_bar"] = wait_for(cdp, "!!document.querySelector('.selection-bar')")
    out["selection_count"] = ev(cdp, "document.querySelector('.selection-count')?.textContent || ''")
    out["has_input"] = ev(cdp, "!!document.querySelector('input.selection-input')")
    out["buttons"] = ev(
        cdp,
        """(() => [...document.querySelectorAll('.selection-bar button')]
        .filter(b=>/加标签|加入相册/.test(b.textContent))
        .map(b=>({text:b.textContent.trim(),disabled:b.disabled})))()""",
    )

    # 加入相册
    ev(cdp, "(() => { const b=[...document.querySelectorAll('.selection-bar button')]"
            ".find(x=>x.textContent.includes('加入相册')); b && b.click(); return !!b; })()")
    out["album_dialog"] = wait_for(cdp, "[aria-label=\"加入相册\"]")
    out["album_dialog_note"] = ev(cdp, "(document.querySelector('[aria-label=\"加入相册\"] .delete-note')?.textContent || '')")
    # 选一个已有相册：断言一次把 3 张都传进去
    wait_for(cdp, "!!document.querySelector('.album-picker-item')", 5)
    out["album_options"] = ev(
        cdp,
        "[...document.querySelectorAll('.album-picker-item span')].map(x=>x.textContent)",
    )
    out["album_click"] = ev(
        cdp,
        "(() => { const b=document.querySelector('.album-picker-item');"
        " if(!b) return 'no-option'; b.click(); return b.querySelector('span')?.textContent; })()",
    )
    out["album_toast"] = wait_text(cdp, "已把 3 张加入相册", 6)
    out["album_toast_text"] = ev(cdp, "document.querySelector('.toast')?.textContent || ''")
    out["selection_cleared_after_album"] = not ev(cdp, "!!document.querySelector('.selection-bar')")

    # 重新选 3 张 → 加标签
    time.sleep(0.5)
    ev(
        cdp,
        """(() => {
        const cells=[...document.querySelectorAll('.cell')].slice(0,3);
        cells.forEach((c)=>c.dispatchEvent(new MouseEvent('click',{bubbles:true,metaKey:true})));
        return cells.length; })()""",
    )
    wait_for(cdp, "!!document.querySelector('.selection-bar')")
    ev(cdp, "(() => { const b=[...document.querySelectorAll('.selection-bar button')]"
            ".find(x=>x.textContent.includes('加标签')); b && b.click(); return !!b; })()")
    out["tag_dialog"] = wait_for(cdp, "[aria-label=\"加标签\"]")
    wait_for(cdp, "!!document.querySelector('.tag-picker-list .album-picker-item')", 5)
    out["tag_options"] = ev(
        cdp,
        "[...document.querySelectorAll('.tag-picker-list .album-picker-item')].slice(0,4).map(x=>x.querySelector('span')?.textContent)",
    )
    ev(cdp, "(() => { const b=document.querySelector('.tag-picker-list .album-picker-item');"
            " b && b.click(); return !!b; })()")
    wait_for(cdp, "!!document.querySelector('.cell')", 6)
    out["tag_toast"] = wait_text(cdp, "已给 3 张加标签", 6)
    out["tag_toast_text"] = ev(cdp, "document.querySelector('.toast')?.textContent || ''")

    # 详情页
    time.sleep(0.4)
    ev(cdp, "document.querySelectorAll('.cell')[0].click()")
    out["detail"] = wait_for(cdp, "!!document.querySelector('.overlay-root')")
    out["actions_text"] = ev(cdp, "document.querySelector('.inspector-actions')?.innerText || ''")
    out["actions_has_delete"] = ev(
        cdp, "(document.querySelector('.inspector-actions')?.innerText || '').includes('删除')")
    out["top_delete"] = ev(cdp, "!!document.querySelector('[aria-label=\"删除这一张\"]')")
    out["top_delete_title"] = ev(cdp, "document.querySelector('[aria-label=\"删除这一张\"]')?.title || ''")
    ev(cdp, "(() => { const b=document.querySelector('[aria-label=\"删除这一张\"]'); b && b.click(); return !!b; })()")
    out["confirm_dialog"] = wait_for(cdp, "!!document.querySelector('.delete-dialog')", 4)
    ev(cdp, "(() => { const b=[...document.querySelectorAll('.delete-dialog button')]"
            ".find(x=>x.textContent.includes('取消')); b && b.click(); return !!b; })()")

    # 回到网格：紧凑密度只显示日期
    ev(cdp, "(() => { const b=[...document.querySelectorAll('.nav-btn, .icon-button, button')]"
            ".find(x=>x.getAttribute('aria-label')==='关闭详情'); b && b.click(); return !!b; })()")
    time.sleep(0.6)
    ev(cdp, "(() => { const b=document.querySelector('[aria-label=\"紧凑 8 列\"]'); b && b.click(); return !!b; })()")
    time.sleep(0.8)
    out["compact_meta"] = ev(cdp, "document.querySelector('.cell .cell-meta')?.textContent || ''")
    out["compact_density"] = ev(cdp, "document.querySelector('.cell')?.dataset.density || ''")
    out["grid_still"] = ev(cdp, "document.querySelectorAll('.cell').length > 3")
    return out


def main() -> int:
    profile = tempfile.mkdtemp(prefix="shiguang-accept-")
    original = FIXTURE.read_text()
    data = json.loads(original)
    mutated = json.loads(original)
    # fixture 没有 user_tags：借 facets.tags 顶上，验证面板能列已有标签
    mutated["facets"]["user_tags"] = data["facets"].get("user_tags") or [
        [name, count] for name, count in data["facets"]["tags"][:5]
    ]
    # fixture 没有相册：给两条，验证「选已有相册」这条路径
    mutated["facets"]["albums"] = data["facets"].get("albums") or [
        ["家庭", 4],
        ["旅行", 3],
    ]
    FIXTURE.write_text(json.dumps(mutated, ensure_ascii=False))
    chrome = None
    try:
        chrome, cdp = launch(URL, profile)
        time.sleep(2.5)
        result = run(cdp)
        print(json.dumps(result, ensure_ascii=False, indent=1))
        return 0
    finally:
        FIXTURE.write_text(original)
        if chrome is not None:
            chrome.terminate()
            try:
                chrome.wait(timeout=5)
            except subprocess.TimeoutExpired:
                chrome.kill()
        shutil.rmtree(profile, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
