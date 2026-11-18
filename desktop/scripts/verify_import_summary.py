#!/usr/bin/env python3
"""导入完成总结页的 DOM 验收（浏览器 fixture + headless Chrome）。

依赖一个 vite dev server（默认 http://localhost:5199），并临时把
public/sample-fixture.json 的 assets 清空、跑完恢复，保证进入的是空状态导入。
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from measure_fps import CHROME, Cdp, free_port  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "public" / "sample-fixture.json"


def launch(url: str, profile: str):
    port = free_port()
    chrome = subprocess.Popen(
        [CHROME, "--headless=new", "--disable-gpu", f"--remote-debugging-port={port}",
         f"--user-data-dir={profile}", "--window-size=1500,940", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    import urllib.request
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


def run(cdp) -> dict:
    out: dict = {}
    out["empty_state"] = wait_for(cdp, "!!document.querySelector('.empty-state')")

    # 选文件夹 → 进度视图 → 收敛成总结页
    ev(cdp, "window.__fixtureFolder='/private/tmp/sg-summary-folder'")
    ev(cdp, "(() => { const b=[...document.querySelectorAll('.empty-card')]"
            ".find(x=>x.textContent.includes('扫描本地文件夹')); if(b) b.click(); return !!b; })()")
    out["progress_view"] = wait_for(cdp, "!!document.querySelector('.import-progress')")
    ev(cdp, "window.dispatchEvent(new CustomEvent('import-progress',"
            "{detail:{stage:'ingest',seen:2500,new:2500,skipped:0}}))")
    ev(cdp, "window.dispatchEvent(new CustomEvent('import-progress',{detail:{stage:'ingest-done'}}))")
    ev(cdp, "window.__fixtureImportResolve && window.__fixtureImportResolve()")
    out["summary_shown"] = wait_for(cdp, "!!document.querySelector('.import-summary')")
    out["title"] = ev(cdp, "document.querySelector('.import-summary-head h2')?.textContent || ''")
    out["subtitle"] = ev(cdp, "document.querySelector('.import-summary-head p')?.textContent || ''")
    out["stats"] = ev(cdp, "[...document.querySelectorAll('.import-summary-stats dd')]"
                            ".map(x=>x.textContent.replace(/\\s+/g,' ').trim())")
    out["note"] = ev(cdp, "document.querySelector('.import-summary-note')?.textContent || ''")
    out["note_keys"] = ev(cdp, "document.querySelector('.import-summary-note')?.dataset.suggestion || ''")

    # 去图库清理 → space
    ev(cdp, "(() => { const b=[...document.querySelectorAll('.import-summary-actions button')]"
            ".find(x=>x.textContent.includes('去图库清理')); if(b) b.click(); return !!b; })()")
    out["space_view"] = wait_for(cdp, "!!document.querySelector('.space-view')")
    out["summary_gone_after_cleanup"] = not ev(cdp, "!!document.querySelector('.import-summary')")

    # 回到图库：再次进入不应再弹
    ev(cdp, "(() => { const b=[...document.querySelectorAll('button.nav-item')]"
            ".find(x=>/全部照片/.test(x.textContent)); if(b) b.click(); return !!b; })()")
    time.sleep(0.6)
    out["summary_absent_on_reenter"] = not ev(cdp, "!!document.querySelector('.import-summary')")

    # 点「开始浏览」的路径
    ev(cdp, "(() => { const b=[...document.querySelectorAll('.empty-card')]"
            ".find(x=>x.textContent.includes('扫描本地文件夹')); if(b) b.click(); return !!b; })()")
    out["progress_again"] = wait_for(cdp, "!!document.querySelector('.import-progress')")
    ev(cdp, "window.dispatchEvent(new CustomEvent('import-progress',"
            "{detail:{stage:'ingest',seen:40,new:40,skipped:0}}))")
    ev(cdp, "window.__fixtureImportResolve && window.__fixtureImportResolve()")
    out["summary_again"] = wait_for(cdp, "!!document.querySelector('.import-summary')")
    ev(cdp, "(() => { const b=[...document.querySelectorAll('.import-summary-actions button')]"
            ".find(x=>x.textContent.includes('开始浏览')); if(b) b.click(); return !!b; })()")
    time.sleep(0.5)
    out["browse_closes"] = not ev(cdp, "!!document.querySelector('.import-summary')")

    # 第二次导入：总数 32826、新增 40 → 正常副标题；第二次进来已是空态（fixture 没变）才可再触发
    return out


def main() -> int:
    url = "http://localhost:5199/?theme=dark"
    profile = tempfile.mkdtemp(prefix="shiguang-summary-")
    original = FIXTURE.read_text()
    data = json.loads(original)
    empty = dict(data)
    empty["assets"] = []
    empty["stats"] = {**data["stats"], "assets": 0, "captions": 0}
    FIXTURE.write_text(json.dumps(empty, ensure_ascii=False))
    chrome = None
    try:
        chrome, cdp = launch(url, profile)
        time.sleep(2.5)
        result = run(cdp)
        # 第二轮：unlabeled 置 0，应改成「重复」提示
        cdp.call("Page.navigate", {"url": url})
        time.sleep(2.2)
        ev(cdp, "window.__fixtureImportSummary={unlabeled:0}")
        ev(cdp, "window.__fixtureFolder='/private/tmp/sg-summary-folder'")
        ev(cdp, "(() => { const b=[...document.querySelectorAll('.empty-card')]"
                ".find(x=>x.textContent.includes('扫描本地文件夹')); if(b) b.click(); return !!b; })()")
        wait_for(cdp, "!!document.querySelector('.import-progress')")
        ev(cdp, "window.dispatchEvent(new CustomEvent('import-progress',"
                "{detail:{stage:'ingest',seen:300,new:300,skipped:0}}))")
        ev(cdp, "window.__fixtureImportResolve && window.__fixtureImportResolve()")
        wait_for(cdp, "!!document.querySelector('.import-summary')")
        result["dup_note"] = ev(cdp, "document.querySelector('.import-summary-note')?.textContent || ''")
        result["dup_key"] = ev(cdp, "document.querySelector('.import-summary-note')?.dataset.suggestion || ''")
        result["dup_subtitle"] = ev(cdp, "document.querySelector('.import-summary-head p')?.textContent || ''")

        # 第三轮：空库首次导入（total == new）走「第一批」文案
        cdp.call("Page.navigate", {"url": url})
        time.sleep(2.2)
        ev(cdp, "window.__fixtureImportSummary={total:2500,unlabeled:0,dup:{ready:false,groups:0,count:0,reclaim:0},screenshots:12}")
        ev(cdp, "window.__fixtureFolder='/private/tmp/sg-summary-folder'")
        ev(cdp, "(() => { const b=[...document.querySelectorAll('.empty-card')]"
                ".find(x=>x.textContent.includes('扫描本地文件夹')); if(b) b.click(); return !!b; })()")
        wait_for(cdp, "!!document.querySelector('.import-progress')")
        ev(cdp, "window.dispatchEvent(new CustomEvent('import-progress',"
                "{detail:{stage:'ingest',seen:2500,new:2500,skipped:0}}))")
        ev(cdp, "window.__fixtureImportResolve && window.__fixtureImportResolve()")
        wait_for(cdp, "!!document.querySelector('.import-summary')")
        result["first_batch"] = ev(cdp, "document.querySelector('.import-summary-head p')?.textContent || ''")
        result["screenshot_note"] = ev(cdp, "document.querySelector('.import-summary-note')?.textContent || ''")
        result["screenshot_key"] = ev(cdp, "document.querySelector('.import-summary-note')?.dataset.suggestion || ''")

        # 第四轮：unlabeled 有值 → 「开始识别」真的打开识别面板并关掉总结页
        cdp.call("Page.navigate", {"url": url})
        time.sleep(2.2)
        ev(cdp, "window.__fixtureImportSummary={unlabeled:2982}")
        ev(cdp, "window.__fixtureFolder='/private/tmp/sg-summary-folder'")
        ev(cdp, "(() => { const b=[...document.querySelectorAll('.empty-card')]"
                ".find(x=>x.textContent.includes('扫描本地文件夹')); if(b) b.click(); return !!b; })()")
        wait_for(cdp, "!!document.querySelector('.import-progress')")
        ev(cdp, "window.__fixtureImportResolve && window.__fixtureImportResolve()")
        wait_for(cdp, "!!document.querySelector('.import-summary')")
        result["unlabeled_button"] = ev(cdp, "(() => { const b=[...document.querySelectorAll('.import-summary-note button')]"
                ".find(x=>x.textContent.includes('开始识别')); if(!b) return 'no-button'; b.click(); return 'clicked'; })()")
        time.sleep(0.8)
        result["recognize_dialog"] = ev(cdp, "!!document.querySelector('.recognition-dialog')")
        result["recognize_backdrop"] = ev(cdp, "!!document.querySelector('.dialog-backdrop')")
        result["recognize_text"] = ev(cdp, "(document.querySelector('.dialog-backdrop')?.textContent||'').slice(0,60)")
        result["summary_closed_by_recognize"] = not ev(cdp, "!!document.querySelector('.import-summary')")
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
