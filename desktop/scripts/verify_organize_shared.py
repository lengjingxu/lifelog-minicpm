#!/usr/bin/env python3
"""整理视图「跨态共享节点」验收：节点唯一性 / 图片不重复请求 / 落位帧等价 / CLS / reduced-motion / 三态帧率。

要求 Python >= 3.9（只用标准库）。

健壮性：
- 看门狗跑在独立线程，超时先 faulthandler.dump_traceback（能看出主线程卡在哪一层）再 os._exit(2)
- 每个 CDP 调用都有 socket 超时，页面卡死不会无限阻塞
- 日志每行带 PID 与时间，写入用 append；--log 指定文件，默认 stderr
- 单实例锁 /tmp/sg-verify.lock：已有活实例时直接退出（退出码 3），避免两个实例互相截断输出

用法:
    python3 scripts/verify_organize_shared.py --url http://localhost:5177 --out /tmp/vs --only main --timeout 60
"""
from __future__ import annotations

import argparse
import atexit
import base64
import faulthandler
import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from measure_fps import CHROME, Cdp, free_port  # noqa: E402

LOCK_PATH = "/tmp/sg-verify.lock"
STAGE = {"name": "init", "since": time.time()}
LOG = {"fh": None}
RUN_ID = uuid.uuid4().hex[:8]
STARTED = time.time()


def log(message: str) -> None:
    line = "[%d] [%s] [%s] %s" % (os.getpid(), time.strftime("%H:%M:%S"), RUN_ID, message)
    print(line, flush=True)
    if LOG["fh"]:
        LOG["fh"].write(line + chr(10))
        LOG["fh"].flush()


def stage(name: str) -> None:
    STAGE["name"] = name
    STAGE["since"] = time.time()
    log("[stage] " + name)


def start_watchdog(seconds: float) -> None:
    deadline = time.time() + seconds

    def loop() -> None:
        while True:
            if time.time() >= deadline:
                log("[timeout] stuck at stage: %s (%.0fs in stage)" % (STAGE["name"], time.time() - STAGE["since"]))
                faulthandler.dump_traceback(file=sys.stderr)
                sys.stderr.flush()
                os._exit(2)
            time.sleep(0.5)

    thread = threading.Thread(target=loop, name="watchdog", daemon=True)
    thread.start()
    log("[watchdog] armed deadline=+%.0fs (thread=%s)" % (seconds, thread.is_alive()))
    return thread


def start_heartbeat(interval: float = 5.0) -> None:
    """每 5s 打一行，用来判断进程是活着还是被外部杀掉了。"""

    def loop() -> None:
        while True:
            time.sleep(interval)
            log("[heartbeat] stage=%s elapsed=%.0fs" % (STAGE["name"], time.time() - STARTED))

    threading.Thread(target=loop, name="heartbeat", daemon=True).start()
    log("[heartbeat] armed interval=%.0fs" % interval)


def install_signal_handlers() -> None:
    """被 supervisor kill 时留下证据：SIGKILL 抓不到，但 SIGTERM/SIGINT/SIGHUP 能。"""

    def handler(signum, _frame):
        log("[signal] received %s at stage=%s，即将退出" % (signal.Signals(signum).name, STAGE["name"]))
        os._exit(2)

    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        try:
            signal.signal(sig, handler)
        except (ValueError, OSError):
            pass


def acquire_lock() -> None:
    try:
        with open(LOCK_PATH, "r", encoding="utf-8") as f:
            pid = int((f.read() or "0").strip() or 0)
    except Exception:
        pid = 0
    if pid and pid != os.getpid():
        try:
            os.kill(pid, 0)
            log("[lock] another run is alive (pid=%d), exit" % pid)
            raise SystemExit(3)
        except ProcessLookupError:
            pass
        except PermissionError:
            pass
    with open(LOCK_PATH, "w", encoding="utf-8") as f:
        f.write(str(os.getpid()))


def release_lock() -> None:
    try:
        with open(LOCK_PATH, "r", encoding="utf-8") as f:
            if (f.read() or "").strip() == str(os.getpid()):
                os.remove(LOCK_PATH)
    except Exception:
        pass


def call_timeout(cdp, method: str, params=None, seconds: float = 15):
    """给单个 CDP 调用加硬超时：页面卡死时抛 TimeoutError，而不是无限阻塞。"""
    cdp.sock.settimeout(seconds)
    try:
        return cdp.call(method, params or {})
    except socket.timeout:
        raise TimeoutError("CDP %s timed out after %.0fs" % (method, seconds))


def eval_timeout(cdp, expression: str, await_promise: bool = False, seconds: float = 20):
    cdp.sock.settimeout(seconds)
    try:
        return cdp.eval(expression, await_promise=await_promise)
    except socket.timeout:
        raise TimeoutError("Runtime.evaluate timed out after %.0fs" % seconds)


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
    return eval_timeout(
        cdp,
        "(() => { const b=[...document.querySelectorAll('button,a')]"
        ".find((x)=>(x.textContent||'').trim().startsWith(" + json.dumps(text) + "));"
        " if(!b) return 'not-found'; b.click(); return 'ok'; })()",
    )


def shot(cdp, path):
    r = call_timeout(cdp, "Page.captureScreenshot", {"format": "png"}, seconds=20)
    with open(path, "wb") as f:
        f.write(base64.b64decode(r["result"]["data"]))
    log("[shot] " + path)


def launch(url, theme, reduced, tag):
    port = free_port()
    prof = "/tmp/sg-org-%s-%d" % (tag, os.getpid())
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
    call_timeout(cdp, "Runtime.enable")
    call_timeout(cdp, "Page.enable")
    call_timeout(cdp, "Page.bringToFront")
    if reduced:
        call_timeout(cdp, "Emulation.setEmulatedMedia", {
            "features": [{"name": "prefers-reduced-motion", "value": "reduce"}],
        })
    full = url + ("&" if "?" in url else "?") + "theme=" + theme
    call_timeout(cdp, "Page.navigate", {"url": full}, seconds=30)
    time.sleep(4)
    eval_timeout(cdp, INSTRUMENT)
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
        result["fps_idle"] = eval_timeout(cdp, RAF_SAFE + "(2.5)", await_promise=True)
        stage("start session")
        result["start"] = click(cdp, "开始整理")

        stage("capture flight frames")
        shots = 0
        t0 = time.time()
        while time.time() - t0 < 26:
            flying = eval_timeout(cdp, FLYING)
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
        result["fps_running"] = eval_timeout(cdp, RAF_SAFE + "(3)", await_promise=True)

        stage("wait for completion")
        deadline = time.time() + 90
        while time.time() < deadline:
            if eval_timeout(cdp, DONE):
                break
            time.sleep(0.5)
        time.sleep(0.8)

        stage("measure done fps")
        result["fps_done"] = eval_timeout(cdp, RAF_SAFE + "(2.5)", await_promise=True)
        shot(cdp, os.path.join(args.out, "p2-shared-done.png"))

        stage("collect results")
        result["shots"] = shots
        result["dup"] = eval_timeout(cdp, DUP)
        result["cls"] = eval_timeout(cdp, "window.__cls")
        result["cls_entries"] = eval_timeout(cdp, "window.__clsN")
        result["landing"] = eval_timeout(cdp, "JSON.stringify(window.__landing || [])")
        result["anim_keys"] = eval_timeout(cdp, "JSON.stringify([...new Set(window.__animKeys || [])])")
        result["img_reqs"] = eval_timeout(cdp, "(window.__imgReqs||[]).length")
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
            dups = max(dups, int(eval_timeout(cdp, DUP) or 0))
            max_flying = max(max_flying, int(eval_timeout(cdp, FLYING) or 0))
            if eval_timeout(cdp, DONE):
                break
            time.sleep(0.1)
        out["dup"] = dups
        out["max_flying"] = max_flying
        out["keys"] = eval_timeout(cdp, "JSON.stringify([...new Set(window.__animKeys || [])])")
    finally:
        chrome.terminate()
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:5177")
    ap.add_argument("--out", default="marketing/shots")
    ap.add_argument("--only", choices=["main", "reduced", "both"], default="both")
    ap.add_argument("--timeout", type=float, default=150.0)
    ap.add_argument("--log", default="")
    args = ap.parse_args()

    if args.log:
        LOG["fh"] = open(args.log, "a", encoding="utf-8", buffering=1)
    acquire_lock()
    os.makedirs(args.out, exist_ok=True)
    log("[start] only=%s timeout=%.0fs out=%s" % (args.only, args.timeout, args.out))
    start_watchdog(args.timeout)
    start_heartbeat()
    install_signal_handlers()
    atexit.register(lambda: log("[exit] normal return, elapsed=%.0fs" % (time.time() - STARTED)))

    try:
        if args.only == "reduced":
            log(json.dumps(run_reduced(args), ensure_ascii=False, indent=1))
            return

        r = run_main(args)
        summary = {k: v for k, v in r.items() if k != "landing"}
        log(json.dumps(summary, ensure_ascii=False, indent=1))

        landing = json.loads(r.get("landing") or "[]")
        log("landing samples: %d" % len(landing))
        bad = 0
        for item in landing[:8]:
            delta = max(abs(item["a"][i] - item["b"][i]) for i in range(4))
            op = [float(x) for x in item["opacity"]]
            ok = delta <= 0.5 and item["radius"][0] == item["radius"][1] and abs(op[0] - op[1]) < 0.01
            if not ok:
                bad += 1
            log("   %s delta=%.2fpx radius=%s opacity=%s complete=%s newImg=%s nodes=%s %s"
                % (item["id"], delta, item["radius"], item["opacity"], item["complete"],
                   item["newImg"], item["nodes"], "OK" if ok else "MISMATCH"))
        log("landing mismatches: %d" % bad)

        if args.only == "both":
            log(json.dumps(run_reduced(args), ensure_ascii=False, indent=1))
    except TimeoutError as exc:
        log("[abort] %s at stage %s" % (exc, STAGE["name"]))
        raise SystemExit(2)
    finally:
        release_lock()


if __name__ == "__main__":
    main()
