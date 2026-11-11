#!/usr/bin/env python3
"""Measure detail-open latency: double-click a cell -> panel visible -> full image painted.

Standard library only; launches headless Chrome and drives it over CDP, same
approach as scripts/measure_fps.py.

Usage:
    python3 scripts/measure_open_latency.py --url http://localhost:5176 [--runs 3]

Prints one JSON object per run with:
    panel_ms  double-click to the detail panel's first painted frame (thumbnail stage)
    full_ms   double-click to the 1600px image's first painted frame
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.request

from measure_fps import CHROME, Cdp, free_port

PROBE = """(async (hoverMs) => {
  const t0 = performance.now();
  const cell = document.querySelector('.cell');
  if (!cell) return { error: 'no cell' };
  if (hoverMs > 0) {
    cell.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
    cell.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await new Promise(r => setTimeout(r, hoverMs));
  }
  cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

  const nextFrame = () => new Promise(r => requestAnimationFrame(r));
  const visible = (el) => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.opacity !== '0';
  };

  let panel = null;
  const deadline = t0 + 5000;
  while (performance.now() < deadline) {
    await nextFrame();
    const root = document.querySelector('.overlay-root');
    if (root && visible(root.querySelector('.stage-image') || root)) {
      panel = performance.now() - t0;
      break;
    }
  }

  let full = null;
  while (performance.now() < deadline) {
    await nextFrame();
    const img = document.querySelector('.stage-full');
    if (img && img.complete && img.naturalWidth > 0 && visible(img)) {
      full = performance.now() - t0;
      break;
    }
  }
  return {
    panel_ms: panel === null ? null : +panel.toFixed(1),
    full_ms: full === null ? null : +full.toFixed(1),
  };
})"""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://localhost:5176")
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--hover-ms", type=int, default=0)
    parser.add_argument("--theme", choices=["dark", "light"])
    args = parser.parse_args()

    url = args.url
    if args.theme:
        url += ("&" if "?" in url else "?") + f"theme={args.theme}"

    import subprocess
    import tempfile

    port = free_port()
    profile = tempfile.mkdtemp(prefix="shiguang-open-")
    chrome = subprocess.Popen(
        [CHROME, "--headless=new", "--disable-gpu", f"--remote-debugging-port={port}",
         f"--user-data-dir={profile}", "--window-size=1440,900", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        ws = None
        for _ in range(60):
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=1) as resp:
                    targets = json.load(resp)
                pages = [t for t in targets if t.get("type") == "page"]
                if pages:
                    ws = pages[0]["webSocketDebuggerUrl"]
                    break
            except Exception:
                pass
            time.sleep(0.25)
        if not ws:
            print("could not reach Chrome devtools", file=sys.stderr)
            return 2

        cdp = Cdp(ws)
        runs = []
        for _ in range(args.runs):
            cdp.call("Page.navigate", {"url": url})
            time.sleep(2.5)
            runs.append(cdp.eval(PROBE + '(%s)' % args.hover_ms, await_promise=True))
        print(json.dumps(runs, ensure_ascii=False, indent=1))
        return 0
    finally:
        chrome.terminate()
        try:
            chrome.wait(timeout=5)
        except subprocess.TimeoutExpired:
            chrome.kill()


if __name__ == "__main__":
    raise SystemExit(main())

