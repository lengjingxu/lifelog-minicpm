#!/usr/bin/env python3
"""Sample frame deltas across the three organize-view states (idle → running → done)."""
from __future__ import annotations

import argparse, json, sys, time, urllib.request

from measure_fps import CHROME, Cdp, free_port

RECORDER = """(() => {
  if (window.__rec) return 'already';
  window.__rec = { frames: [], t0: performance.now(), last: performance.now() };
  const tick = (ts) => {
    const r = window.__rec;
    r.frames.push({ t: +(ts - r.t0).toFixed(1), dt: +(ts - r.last).toFixed(1) });
    r.last = ts;
    r.raf = requestAnimationFrame(tick);
  };
  window.__rec.raf = requestAnimationFrame(tick);
  return 'ok';
})()"""

STOP = """(() => { if (window.__rec) { cancelAnimationFrame(window.__rec.raf); } return window.__rec ? window.__rec.frames : []; })()"""


def stats(frames):
    if not frames:
        return {"frames": 0}
    dts = [f["dt"] for f in frames[1:]]
    total = frames[-1]["t"] - frames[0]["t"]
    over = [f for f in frames[1:] if f["dt"] > 20]
    return {
        "frames": len(dts),
        "seconds": round(total / 1000, 3),
        "fps": round(len(dts) / (total / 1000), 2) if total > 0 else None,
        "worst_ms": round(max(dts), 1) if dts else None,
        "over20": len(over),
        "over20_at_ms": [f["t"] for f in over][:8],
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:5176")
    ap.add_argument("--timeout", type=float, default=90)
    args = ap.parse_args()

    port = free_port()
    import subprocess, tempfile
    profile = tempfile.mkdtemp(prefix="sg-states-")
    chrome = subprocess.Popen([CHROME, "--headless=new", "--disable-gpu", f"--remote-debugging-port={port}",
                               f"--user-data-dir={profile}", "--window-size=1440,900", "about:blank"],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        ws = None
        for _ in range(60):
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=1) as r:
                    pages = [t for t in json.load(r) if t.get("type") == "page"]
                if pages:
                    ws = pages[0]["webSocketDebuggerUrl"]; break
            except Exception:
                pass
            time.sleep(0.25)
        cdp = Cdp(ws)
        cdp.call("Page.navigate", {"url": args.url})
        time.sleep(3)
        cdp.eval("(() => { const b=[...document.querySelectorAll('button.nav-item')].find(x=>x.textContent.includes('整理视图')); b && b.click(); return !!b })()")
        time.sleep(1.5)

        cdp.eval(RECORDER)
        t_click = time.time()
        cdp.eval("(() => { const b=[...document.querySelectorAll('button')].find(x=>/开始整理/.test(x.textContent)); b && b.click(); return !!b })()")

        deadline = time.time() + args.timeout
        done_at = None
        while time.time() < deadline:
            txt = cdp.eval("document.body.innerText") or ""
            if "查看相册" in txt:
                done_at = time.time() - t_click
                break
            time.sleep(0.5)
        time.sleep(0.6)
        frames = cdp.eval(STOP)
        total_ms = frames[-1]["t"] if frames else 0

        entry = stats([f for f in frames if f["t"] <= 800])
        flight = stats([f for f in frames if 800 < f["t"] <= (done_at * 1000 - 800 if done_at else 2500)])
        exit_win = stats([f for f in frames if done_at and f["t"] >= done_at * 1000 - 800])
        print(json.dumps({"total_ms": total_ms, "done_at_ms": round(done_at * 1000, 1) if done_at else None,
                           "entry": entry, "flight": flight, "exit": exit_win}, ensure_ascii=False, indent=1))
        return 0 if done_at else 3
    finally:
        chrome.terminate()
        try: chrome.wait(timeout=5)
        except subprocess.TimeoutExpired: chrome.kill()


if __name__ == "__main__":
    raise SystemExit(main())

