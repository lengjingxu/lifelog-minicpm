#!/usr/bin/env python3
"""整理视图「跨态共享节点」验收：节点唯一性 / 图片不重复请求 / 落位帧等价 / CLS / reduced-motion / 三态帧率。

要求 Python >= 3.9（只用标准库）。
总超时默认 150s：卡住会打印当前阶段并以退出码 2 结束，不会静默挂死。

用法:
    python3 scripts/verify_organize_shared.py --url http://localhost:5177 --out /tmp/vs --only main
    python3 scripts/verify_organize_shared.py --url http://localhost:5177 --out /tmp/vs --only reduced
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
import threading
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from measure_fps import CHROME, Cdp, free_port  # noqa: E402


STAGE = {"name": "init"}


def stage(name: str) -> None:
    STAGE["name"] = name
    print("[stage] " + name, flush=True)


def start_watchdog(seconds: float) -> None:
    def fire() -> None:
        print("[timeout] stuck at stage: " + STAGE["name"], file=sys.stderr, flush=True)
        os._exit(2)

    timer = threading.Timer(seconds, fire)
    timer.daemon = True
    timer.start()


# 带 setTimeout 兜底的 rAF 采样：页面被遮挡/后台节流时 rAF 不触发，
# 原实现会永远等不到 resolve（这就是在别人机器上挂死的原因）。
RAF_SAFE = """(async (seconds) => {
  const t0 = performance.now();
  let frames = 0, worst = 0, over20 = 0, last = t0;
  const finished = new Promise((resolve) => {
    function tick(ts) {
      const dt = ts - last;
      last = ts;
      if (dt > worst) worst = dt;
      if (dt > 20) over20++;
      frames++;
      if (ts - t0 < seconds * 1000) requestAnimationFrame(tick);
      else resolve("raf");
    }
    requestAnimationFrame(tick);
    setTimeout(() => resolve("timeout"), seconds * 1000 + 1500);
  });
  const ended = await finished;
  const elapsed = Math.max(1, performance.now() - t0);
  return {
    frames,
    seconds: +(elapsed / 1000).toFixed(3),
    fps: +(frames / (elapsed / 1000)).toFixed(2),
    worst_frame_ms: +worst.toFixed(1),
    frames_over_20ms: over20,
    ended,
  };
})"""

INSTRUMENT = r"""
(() => {
  window.__cls = 0;
  window.__clsN = 0;
  window.__imgReqs = [];
  window.__landing = [];
  window.__animKeys = [];

  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) {
      if (e.hadRecentInput) continue;
      window.__cls += e.value;
      window.__clsN += 1;
    }
  }).observe({ type: "layout-shift", buffered: true });

  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) {
      if (e.initiatorType === "img") window.__imgReqs.push(e.name);
    }
  }).observe({ type: "resource", buffered: true });

  const origAnimate = Element.prototype.animate;
  Element.prototype.animate = function (...args) {
    const el = this;
    const frames = Array.isArray(args[0]) ? args[0] : [];
    if (el.dataset && el.dataset.cardId) {
      const keys = new Set();
      for (const f of frames) for (const k of Object.keys(f)) keys.add(k);
      window.__animKeys.push([...keys].sort().join(","));
    }
    const anim = origAnimate.apply(this, args);
    anim.addEventListener("finish", () => {
      if (!el.dataset || !el.dataset.cardId) return;
      const r1 = el.getBoundingClientRect();
      const cs1 = getComputedStyle(el);
      const n1 = window.__imgReqs.length;
      setTimeout(() => {
        const r2 = el.getBoundingClientRect();
        const cs2 = getComputedStyle(el);
        const img = el.querySelector("img");
        window.__landing.push({
          id: el.dataset.cardId,
          a: [r1.x, r1.y, r1.width, r1.height],
          b: [r2.x, r2.y, r2.width, r2.height],
          radius: [cs1.borderRadius, cs2.borderRadius],
          opacity: [cs1.opacity, cs2.opacity],
          complete: img ? img.complete : null,
          newImg: window.__imgReqs.length - n1,
          nodes: document.querySelectorAll('[data-card-id="' + el.dataset.cardId + '"]').length,
        });
      }, 320);
    }, { once: true });
    return anim;
  };
})()
"""

DUP = """(() => {
  const ids = [...document.querySelectorAll('[data-card-id]')].map((e) => e.dataset.cardId);
  const counts = {};
  ids.forEach((x) => { counts[x] = (counts[x] || 0) + 1; });
  return Object.values(counts).filter((c) => c > 1).length;
})()"""

FLYING = "document.querySelectorAll('.pile-card.flying').length"
DONE = "document.body.innerText.includes('查看相册')"


def click(cdp, text):
    return cdp.eval(
        "(() => { const b=[...document.querySelectorAll('button,a')]"
        ".find((x)=>(x.textContent||'').trim().startsWith(" + json.dumps(text) + "));"
        " if(!b) return 'not-found'; b.click(); return 'ok'; })()"
    )


def shot(cdp, path):
    r = cdp.call("Page.captureScreenshot", {"format": "png"})
    with open(path, "wb") as f:
        f.write(base64.b64decode(r["result"]["data"]))
    print("[shot] " + path, flush=True)


def launch(url, theme, reduced, tag):
    port = free_port()
    prof = "/tmp/sg-org-%s-%d" % (tag, int(time.time()))
    chrome = subprocess.Popen(
        [CHROME, "--headless=new", "--disable-gpu",
         "--disable-background-timer-throttling",
         "--disable-renderer-backgrounding",
         "--disable-backgrounding-occluded-windows",
         "--remote-debugging-port=" + str(port),
         "--user-data-dir=" + prof, "--window-size=1440,900", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    ws = None
    for _ in range(160):
        try:
            data = json.load(urllib.request.urlopen("http://127.0.0.1:%d/json/list" % port, timeout=1))
            pages = [t for t in data if t["type"] == "page"]
            if pages:
                ws = pages[0]["webSocketDebuggerUrl"]
                break
        except Exception:
            pass
        time.sleep(0.25)
    if not ws:
        chrome.terminate()
        raise SystemExit("no chrome target")

    cdp = Cdp(ws)
    cdp.call("Runtime.enable")
    cdp.call("Page.enable")
    cdp.call("Page.bringToFront")
    if reduced:
        cdp.call("Emulation.setEmulatedMedia", {
            "features": [{"name": "prefers-reduced-motion", "value": "reduce"}],
        })
    full = url + ("&" if "?" in url else "?") + "theme=" + theme
    cdp.call("Page.navigate", {"url": full})
    time.sleep(4)
    cdp.eval(INSTRUMENT)
    return chrome, cdp


def run_main(args):
    stage("launch")
    chrome, cdp = launch(args.url, "dark", False, "main")
    result = {}
    try:
        stage("enter organize view")
        result["nav"] = click(cdp, "整理视图")
        time.sleep(1.6)
        stage("measure idle fps")
        result["fps_idle"] = cdp.eval(RAF_SAFE + "(2.5)", await_promise=True)
        stage("start session")
        result["start"] = click(cdp, "开始整理")

        stage("capture flight frames")
        shots = 0
        t0 = time.time()
        while time.time() - t0 < 26:
            flying = cdp.eval(FLYING) or 0
            if isinstance(flying, (int, float)) and flying > 0:
                shot(cdp, os.path.join(args.out, "p2-shared-takeoff.png"))
                time.sleep(0.28)
                shot(cdp, os.path.join(args.out, "p2-shared-mid.png"))
                time.sleep(0.36)
                shot(cdp, os.path.join(args.out, "p2-shared-landed.png"))
                shots = 3
                break
            time.sleep(0.05)

        stage("measure running fps")
        result["fps_running"] = cdp.eval(RAF_SAFE + "(3)", await_promise=True)

        stage("wait for completion")
        deadline = time.time() + 90
        while time.time() < deadline:
            if cdp.eval(DONE):
                break
            time.sleep(0.5)
        time.sleep(0.8)

        stage("measure done fps")
        result["fps_done"] = cdp.eval(RAF_SAFE + "(2.5)", await_promise=True)
        shot(cdp, os.path.join(args.out, "p2-shared-done.png"))

        stage("collect results")
        result["shots"] = shots
        result["dup"] = cdp.eval(DUP)
        result["cls"] = cdp.eval("window.__cls")
        result["cls_entries"] = cdp.eval("window.__clsN")
        result["landing"] = cdp.eval("JSON.stringify(window.__landing || [])")
        result["anim_keys"] = cdp.eval("JSON.stringify([...new Set(window.__animKeys || [])])")
        result["img_reqs"] = cdp.eval("(window.__imgReqs||[]).length")
    finally:
        chrome.terminate()
    return result


def run_reduced(args):
    stage("launch (reduced motion)")
    chrome, cdp = launch(args.url, "dark", True, "reduced")
    out = {}
    try:
        stage("enter organize view (reduced)")
        click(cdp, "整理视图")
        time.sleep(1.6)
        stage("start session (reduced)")
        click(cdp, "开始整理")
        stage("sample flights (reduced)")
        t0 = time.time()
        dups = 0
        max_flying = 0
        while time.time() - t0 < 25:
            dups = max(dups, int(cdp.eval(DUP) or 0))
            max_flying = max(max_flying, int(cdp.eval(FLYING) or 0))
            if cdp.eval(DONE):
                break
            time.sleep(0.1)
        out["dup"] = dups
        out["max_flying"] = max_flying
        out["keys"] = cdp.eval("JSON.stringify([...new Set(window.__animKeys || [])])")
    finally:
        chrome.terminate()
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:5177")
    ap.add_argument("--out", default="marketing/shots")
    ap.add_argument("--only", choices=["main", "reduced", "both"], default="both")
    ap.add_argument("--timeout", type=float, default=150.0)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    start_watchdog(args.timeout)

    if args.only == "reduced":
        print(json.dumps(run_reduced(args), ensure_ascii=False, indent=1), flush=True)
        return

    r = run_main(args)
    summary = {k: v for k, v in r.items() if k != "landing"}
    print(json.dumps(summary, ensure_ascii=False, indent=1), flush=True)

    landing = json.loads(r.get("landing") or "[]")
    print("landing samples: %d" % len(landing), flush=True)
    bad = 0
    for item in landing[:8]:
        delta = max(abs(item["a"][i] - item["b"][i]) for i in range(4))
        op = [float(x) for x in item["opacity"]]
        ok = delta <= 0.5 and item["radius"][0] == item["radius"][1] and abs(op[0] - op[1]) < 0.01
        if not ok:
            bad += 1
        print("   %s delta=%.2fpx radius=%s opacity=%s complete=%s newImg=%s nodes=%s %s"
              % (item["id"], delta, item["radius"], item["opacity"], item["complete"],
                 item["newImg"], item["nodes"], "OK" if ok else "MISMATCH"), flush=True)
    print("landing mismatches: %d" % bad, flush=True)

    if args.only == "both":
        print(json.dumps(run_reduced(args), ensure_ascii=False, indent=1), flush=True)


if __name__ == "__main__":
    main()
