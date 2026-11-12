#!/usr/bin/env python3
"""驱动 dev 版 10 万级 UI 基准：起本地接收端 -> 启动 tauri dev -> 收 JSON -> 采样 RSS 峰值。

只用于本机压测，不参与生产构建（前端 bench 代码由 import.meta.env.DEV 关住）。

用法：
    python3 scripts/bench_ui_dev.py --home /tmp/sg-bench-10w --out /tmp/bench-ui.json
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

STATE: dict = {"report": None, "rss_kb": 0, "peak_kb": 0, "pid": None}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # 静音
        return

    def _json(self, payload, code=200):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/rss"):
            self._json({"rss_kb": STATE["rss_kb"]})
            return
        self._json({"ok": True})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length).decode("utf-8", "replace")
        try:
            STATE["report"] = json.loads(raw)
        except Exception:
            STATE["report"] = {"error": "bad json", "raw": raw[:200]}
        self._json({"ok": True})


def app_pid() -> int | None:
    out = subprocess.run(["pgrep", "-f", "shiguang-mac"], capture_output=True, text=True).stdout.split()
    if not out:
        return None
    try:
        return int(out[0])
    except ValueError:
        return None


def sample_rss(stop: threading.Event) -> None:
    while not stop.is_set():
        pid = app_pid()
        if pid and STATE.get("activated") != pid:
            STATE["activated"] = pid
            subprocess.run(
                ["osascript", "-e",
                 'tell application "System Events" to set frontmost of (first process whose unix id is %d) to true' % pid],
                capture_output=True,
            )
        if pid:
            out = subprocess.run(["ps", "-o", "rss=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
            if out.isdigit():
                STATE["rss_kb"] = int(out)
                STATE["peak_kb"] = max(STATE["peak_kb"], int(out))
        time.sleep(0.2)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--home", required=True)
    ap.add_argument("--out", default="/tmp/bench-ui.json")
    ap.add_argument("--port", type=int, default=8799)
    ap.add_argument("--timeout", type=float, default=300)
    args = ap.parse_args()

    server = HTTPServer(("127.0.0.1", args.port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    stop = threading.Event()
    threading.Thread(target=sample_rss, args=(stop,), daemon=True).start()

    env = dict(os.environ)
    env["LIFELOG_HOME"] = os.path.abspath(os.path.expanduser(args.home))
    env["VITE_BENCH"] = "1"
    env["VITE_BENCH_ENDPOINT"] = "http://127.0.0.1:%d/bench" % args.port

    log = open("/tmp/bench-ui-dev.log", "w")
    proc = subprocess.Popen(["npm", "run", "tauri", "dev"], env=env, stdout=log, stderr=subprocess.STDOUT)
    print("[bench] tauri dev started pid=%d, waiting report (timeout %.0fs)" % (proc.pid, args.timeout), flush=True)

    deadline = time.time() + args.timeout
    while time.time() < deadline and STATE["report"] is None:
        time.sleep(0.5)

    stop.set()
    report = STATE["report"] or {"error": "timeout waiting for report"}
    report["rssPeakKb"] = STATE["peak_kb"] or None
    report["rssPeakMb"] = round(STATE["peak_kb"] / 1024, 1) if STATE["peak_kb"] else None
    report["home"] = env["LIFELOG_HOME"]

    proc.terminate()
    try:
        proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        proc.kill()
    subprocess.run(["pkill", "-f", "shiguang-mac"], capture_output=True)
    subprocess.run(["pkill", "-f", "vite"], capture_output=True)

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=1)
    print(json.dumps(report, ensure_ascii=False, indent=1), flush=True)


if __name__ == "__main__":
    main()
