#!/usr/bin/env python3
"""整理视图「跨态共享节点」验收：节点唯一性 / 图片不重复请求 / 落位帧等价 / CLS / reduced-motion / 三态帧率。

用法:
    python3 scripts/verify_organize_shared.py --url http://localhost:5177 --out marketing/shots
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from measure_fps import CHROME, Cdp, RAF_PROBE, free_port  # noqa: E402


INSTRUMENT = r"""
(() => {
  window.__cls = 0;
  window.__clsN = 0;
  window.__imgReqs = [];
  window.__landing = [];
  window.__animKeys = [];
  window.__dups = 0;

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

FLYING = """document.querySelectorAll('.pile-card.flying').length"""


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


def launch(url, theme, reduced, out, tag):
    port = free_port()
    prof = "/tmp/sg-org-%s-%d" % (tag, int(time.time()))
    chrome = subprocess.Popen(
        [CHROME, "--headless=new", "--disable-gpu", "--remote-debugging-port=" + str(port),
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
    chrome, cdp = launch(args.url, "dark", False, args.out, "main")
    result = {}
    try:
        result["nav"] = click(cdp, "整理视图")
        time.sleep(1.6)
        result["fps_idle"] = cdp.eval(RAF_PROBE + "(2.5)", await_promise=True)
        result["start"] = click(cdp, "开始整理")

        shots = 0
        t0 = time.time()
        seen_flying = False
        while time.time() - t0 < 26:
            flying = cdp.eval(FLYING) or 0
            if isinstance(flying, (int, float)) and flying > 0:
                if not seen_flying:
                    seen_flying = True
                    shot(cdp, os.path.join(args.out, "p2-shared-takeoff.png"))
                    time.sleep(0.28)
                    shot(cdp, os.path.join(args.out, "p2-shared-mid.png"))
                    time.sleep(0.36)
                    shot(cdp, os.path.join(args.out, "p2-shared-landed.png"))
                    shots = 3
                    break
            time.sleep(0.05)

        fps_running = cdp.eval(RAF_PROBE + "(3)", await_promise=True)

        for _ in range(120):
            if cdp.eval("document.body.innerText.includes('查看相册')"):
                break
            time.sleep(0.5)
        time.sleep(0.8)
        fps_done = cdp.eval(RAF_PROBE + "(2.5)", await_promise=True)
        shot(cdp, os.path.join(args.out, "p2-shared-done.png"))

        result["shots"] = shots
        result["fps_running"] = fps_running
        result["fps_done"] = fps_done
        result["dup"] = cdp.eval("window.__clsN >= 0 ? (() => { const ids=[...document.querySelectorAll('[data-card-id]')].map(e=>e.dataset.cardId); const c={}; ids.forEach(x=>c[x]=(c[x]||0)+1); return Object.values(c).filter(v=>v>1).length })() : -1")
        result["cls"] = cdp.eval("window.__cls")
        result["cls_entries"] = cdp.eval("window.__clsN")
        result["landing"] = cdp.eval("JSON.stringify(window.__landing || [])")
        result["anim_keys"] = cdp.eval("JSON.stringify([...new Set(window.__animKeys || [])])")
        result["img_reqs"] = cdp.eval("(window.__imgReqs||[]).length")
    finally:
        chrome.terminate()
    return result


def run_reduced(args):
    chrome, cdp = launch(args.url, "dark", True, args.out, "reduced")
    out = {}
    try:
        click(cdp, "整理视图")
        time.sleep(1.6)
        click(cdp, "开始整理")
        t0 = time.time()
        dups = 0
        max_flying = 0
        moved = 0
        while time.time() - t0 < 18:
            d = cdp.eval(DUP)
            dups = max(dups, int(d or 0))
            f = cdp.eval(FLYING) or 0
            max_flying = max(max_flying, int(f))
            time.sleep(0.1)
            if cdp.eval("document.body.innerText.includes('查看相册')"):
                break
        out["dup"] = dups
        out["max_flying"] = max_flying
        out["keys"] = cdp.eval("JSON.stringify([...new Set(window.__animKeys || [])])")
        out["moved"] = moved
    finally:
        chrome.terminate()
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:5177")
    ap.add_argument("--out", default="marketing/shots")
    ap.add_argument("--only", choices=["main", "reduced", "both"], default="both")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    if args.only == "reduced":
        print("== reduced-motion ==")
        print(json.dumps(run_reduced(args), ensure_ascii=False, indent=1))
        return

    r = run_main(args)
    print("== main ==")
    print(json.dumps({k: v for k, v in r.items() if k != "landing"}, ensure_ascii=False, indent=1))
    landing = json.loads(r.get("landing") or "[]")
    print("landing samples:", len(landing))
    bad = 0
    for item in landing[:8]:
        d = max(abs(item["a"][i] - item["b"][i]) for i in range(4))
        op = [float(x) for x in item["opacity"]]
        ok = d <= 0.5 and item["radius"][0] == item["radius"][1] and abs(op[0] - op[1]) < 0.01
        if not ok:
            bad += 1
        print("  ", item["id"], "delta=%.2fpx" % d, "radius", item["radius"],
              "opacity", item["opacity"], "complete", item["complete"],
              "newImg", item["newImg"], "nodes", item["nodes"], "OK" if ok else "MISMATCH")
    print("landing mismatches:", bad)

    if args.only == "both":
        print("== reduced-motion ==")
        print(json.dumps(run_reduced(args), ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
