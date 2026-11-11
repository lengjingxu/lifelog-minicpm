#!/usr/bin/env python3
"""Measure animation frame rate of the 拾光 desktop UI in a headless browser.

Uses only the standard library: it launches Chrome with the remote debugging
port, drives the page over CDP and samples requestAnimationFrame deltas.

Usage:
    python3 scripts/measure_fps.py --url http://localhost:5174 [--scenario both] [--seconds 3]

Scenarios:
    organize  enter 整理视图 and start a session, then sample during the animation
    detail    open the first photo (detail + inspector), then sample the open animation
    both      run both in sequence (default)
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Cdp:
    def __init__(self, ws_url: str):
        rest = ws_url.split("://", 1)[1]
        hostport, path = rest.split("/", 1)
        host, port = hostport.split(":")
        self.sock = socket.create_connection((host, int(port)), timeout=20)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (f"GET /{path} HTTP/1.1\r\nHost: {hostport}\r\nUpgrade: websocket\r\n"
               f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
               f"Sec-WebSocket-Version: 13\r\n\r\n")
        self.sock.sendall(req.encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            buf += self.sock.recv(4096)
        self._id = 0

    def _send(self, obj: dict) -> None:
        data = json.dumps(obj).encode()
        header = bytearray([0x81])
        n = len(data)
        mask = os.urandom(4)
        if n < 126:
            header.append(0x80 | n)
        elif n < 65536:
            header.append(0x80 | 126)
            header += struct.pack(">H", n)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", n)
        header += mask
        self.sock.sendall(bytes(header) + bytes(bytearray(b ^ mask[i % 4] for i, b in enumerate(data))))

    def _recv(self) -> str | None:
        def read(n: int) -> bytes:
            out = b""
            while len(out) < n:
                chunk = self.sock.recv(n - len(out))
                if not chunk:
                    raise RuntimeError("cdp socket closed")
                out += chunk
            return out

        head = read(2)
        opcode = head[0] & 0x0F
        length = head[1] & 0x7F
        if length == 126:
            length = struct.unpack(">H", read(2))[0]
        elif length == 127:
            length = struct.unpack(">Q", read(8))[0]
        payload = read(length)
        return payload.decode("utf-8", "replace") if opcode == 0x1 else None

    def call(self, method: str, params: dict | None = None) -> dict:
        self._id += 1
        mid = self._id
        self._send({"id": mid, "method": method, "params": params or {}})
        while True:
            raw = self._recv()
            if not raw:
                continue
            msg = json.loads(raw)
            if msg.get("id") == mid:
                return msg

    def eval(self, expression: str, await_promise: bool = False):
        msg = self.call("Runtime.evaluate", {
            "expression": expression,
            "returnByValue": True,
            "awaitPromise": await_promise,
        })
        result = (msg.get("result") or {}).get("result") or {}
        return result.get("value", result.get("description"))


RAF_PROBE = """(async (seconds) => {
  const t0 = performance.now();
  let frames = 0, worst = 0, over20 = 0, last = t0;
  await new Promise((resolve) => {
    function tick(ts) {
      const dt = ts - last;
      last = ts;
      if (dt > worst) worst = dt;
      if (dt > 20) over20++;
      frames++;
      if (ts - t0 < seconds * 1000) requestAnimationFrame(tick);
      else resolve();
    }
    requestAnimationFrame(tick);
  });
  const elapsed = performance.now() - t0;
  return {
    frames,
    seconds: +(elapsed / 1000).toFixed(3),
    fps: +(frames / (elapsed / 1000)).toFixed(2),
    worst_frame_ms: +worst.toFixed(1),
    frames_over_20ms: over20,
  };
})"""


def click_by_text(cdp: Cdp, text: str, selector: str = "button,a,div,li") -> str:
    expr = (
        "(() => { const els=[...document.querySelectorAll(%r)];"
        " const el=els.filter(e=>e.children.length<=2).find(e=>(e.textContent||'').trim().startsWith(%r));"
        " if(!el) return 'not-found'; el.click(); return 'ok'; })()" % (selector, text)
    )
    return cdp.eval(expr)


def with_theme(url: str, theme: str | None) -> str:
    if not theme:
        return url
    sep = "&" if "?" in url else "?"
    return f"{url}{sep}theme={theme}"


def run_scenario(cdp: Cdp, scenario: str, seconds: float) -> dict:
    if scenario == "organize":
        enter = cdp.eval(
            "(() => { const b=[...document.querySelectorAll('button.nav-item')]"
            ".find(x=>x.textContent.includes('整理视图')); if(!b) return 'not-found'; b.click(); return 'ok'; })()"
        )
        time.sleep(1.5)
        start = cdp.eval(
            "(() => { const b=[...document.querySelectorAll('button')]"
            ".find(x=>/开始整理/.test(x.textContent)); if(!b) return 'not-found'; b.click(); return 'ok'; })()"
        )
        time.sleep(0.8)
        sample = cdp.eval(RAF_PROBE + "(%s)" % seconds, await_promise=True)
        return {"scenario": scenario, "enter": enter, "start": start, **sample}

    if scenario == "detail":
        cdp.eval(
            "(() => { const b=[...document.querySelectorAll('button.nav-item')]"
            ".find(x=>x.textContent.includes('全部照片')); if(b) b.click(); return 'ok'; })()"
        )
        time.sleep(1.2)
        opened = cdp.eval(
            "(() => { const img=document.querySelector('.cell img, img');"
            " if(!img) return 'not-found'; const cell=img.closest('button,li,div');"
            " (cell||img).dispatchEvent(new MouseEvent('dblclick',{bubbles:true})); return 'ok'; })()"
        )
        time.sleep(0.8)
        sample = cdp.eval(RAF_PROBE + "(%s)" % seconds, await_promise=True)
        return {"scenario": scenario, "open": opened, **sample}

    raise SystemExit(f"unknown scenario {scenario}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://localhost:5174")
    parser.add_argument("--scenario", choices=["organize", "detail", "both"], default="both")
    parser.add_argument("--seconds", type=float, default=3.0)
    parser.add_argument("--theme", choices=["dark", "light"],
                        help="append ?theme=<value> so the app renders that theme for this run")
    args = parser.parse_args()

    if not shutil.which(CHROME) and not os.path.exists(CHROME):
        print("Chrome not found at", CHROME, file=sys.stderr)
        return 2

    port = free_port()
    profile = tempfile.mkdtemp(prefix="shiguang-fps-")
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

        url = with_theme(args.url, args.theme)
        cdp = Cdp(ws)
        cdp.call("Page.navigate", {"url": url})
        time.sleep(3)

        scenarios = ["organize", "detail"] if args.scenario == "both" else [args.scenario]
        results = []
        for scenario in scenarios:
            cdp.call("Page.navigate", {"url": url})
            time.sleep(2.5)
            results.append({"theme": args.theme or "default", **run_scenario(cdp, scenario, args.seconds)})
        print(json.dumps(results, ensure_ascii=False, indent=1))
        return 0
    finally:
        chrome.terminate()
        try:
            chrome.wait(timeout=5)
        except subprocess.TimeoutExpired:
            chrome.kill()


if __name__ == "__main__":
    raise SystemExit(main())

