/**
 * 仅 dev 生效的 10 万级 UI 基准。
 * 触发条件：import.meta.env.DEV && (URL 带 ?bench=1 或 VITE_BENCH=1)。
 * 生产构建里 DEV 为 false，这段代码不会运行。
 *
 * 结果通过 POST 发到 VITE_BENCH_ENDPOINT（默认 http://127.0.0.1:8799/bench），
 * 由 external 驱动脚本落盘，不进仓库。
 */

type Tier = { label: string; query: string };

const ENDPOINT = (import.meta.env.VITE_BENCH_ENDPOINT as string) || "http://127.0.0.1:8799/bench";

function enabled(): boolean {
  if (!import.meta.env.DEV) return false;
  const flag = new URLSearchParams(location.search).get("bench");
  return flag === "1" || import.meta.env.VITE_BENCH === "1";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(fn: () => T | null, timeoutMs: number): Promise<T> {
  const started = performance.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (performance.now() - started > timeoutMs) throw new Error("waitFor timeout");
    await sleep(16);
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function p95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return sorted[index];
}

function frames(seconds: number): Promise<{ fps: number; worst: number; over20: number; over50: number; count: number }> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let last = t0;
    let count = 0;
    let worst = 0;
    let over20 = 0;
    let over50 = 0;
    const tick = (ts: number) => {
      const dt = ts - last;
      last = ts;
      if (dt > worst) worst = dt;
      if (dt > 20) over20 += 1;
      if (dt > 50) over50 += 1;
      count += 1;
      if (ts - t0 < seconds * 1000) requestAnimationFrame(tick);
      else {
        const elapsed = Math.max(1, performance.now() - t0);
        resolve({ fps: +((count / elapsed) * 1000).toFixed(2), worst: +worst.toFixed(1), over20, over50, count });
      }
    };
    requestAnimationFrame(tick);
  });
}

function navTo(label: string): boolean {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button.nav-item")].find((b) =>
    (b.textContent || "").trim().startsWith(label),
  );
  if (!button) return false;
  button.click();
  return true;
}

function setSearch(value: string): void {
  const input = document.querySelector<HTMLInputElement>('input[placeholder^="搜索"]');
  if (!input) return;
  input.focus();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function measureSearch(tier: Tier, queryAssets: typeof import("./api").queryAssets) {
  // 直接量 queryAssets 的往返（IPC + SQL），不受窗口是否被遮挡影响；
  // 渲染是虚拟滚动，只挂视口 ±2 行，不随命中数线性增长。
  const samples: number[] = [];
  let rows = 0;
  for (let i = 0; i < 5; i += 1) {
    const started = performance.now();
    const list = await queryAssets({ query: tier.query, limit: 500 });
    samples.push(performance.now() - started);
    rows = list.length;
    await sleep(80);
  }
  return {
    label: tier.label,
    query: tier.query,
    rows,
    p50: Math.round(median(samples)),
    p95: Math.round(p95(samples)),
    render: "virtual",
  };
}

async function run(): Promise<Record<string, unknown>> {
  const { queryAssets } = await import("./api");
  const report: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    origin: "tauri-webview",
    visibility: document.visibilityState,
    focused: document.hasFocus(),
  };

  await waitFor(() => document.querySelector(".grid-scroll .cell"), 60000);
  report.coldFirstMs = Math.round(performance.now());

  const warm: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    navTo("时间线");
    await sleep(400);
    const t0 = performance.now();
    navTo("全部照片");
    await waitFor(() => document.querySelector(".grid-scroll .cell"), 10000);
    await sleep(120);
    warm.push(performance.now() - t0);
  }
  report.warmReopenMs = { p50: Math.round(median(warm)), p95: Math.round(p95(warm)), samples: warm.map(Math.round) };

  setSearch("");
  await sleep(500);

  const scrollEl = document.querySelector<HTMLElement>(".grid-scroll");
  if (scrollEl && document.visibilityState !== "visible") {
    // 窗口被遮挡时 WKWebView 会节流 rAF，这时测出来的 fps 无意义，直接标记跳过
    report.scroll = { skipped: "window not visible: " + document.visibilityState };
  } else if (scrollEl) {
    const before = scrollEl.scrollTop;
    let raf = 0;
    const spin = () => {
      scrollEl.scrollTop += 42;
      raf = requestAnimationFrame(spin);
    };
    raf = requestAnimationFrame(spin);
    report.scroll = await frames(5);
    cancelAnimationFrame(raf);
    scrollEl.scrollTop = before;
  }

  const tiers: Tier[] = [
    { label: "low", query: (import.meta.env.VITE_BENCH_Q1 as string) || "生日" },
    { label: "mid", query: (import.meta.env.VITE_BENCH_Q2 as string) || "公园" },
    { label: "high", query: (import.meta.env.VITE_BENCH_Q3 as string) || "风景" },
  ];
  const searches = [];
  for (const tier of tiers) {
    searches.push(await measureSearch(tier, queryAssets));
  }
  report.search = searches;
  report.visibilityAfter = document.visibilityState;

  setSearch("");
  await sleep(300);

  const rss = await fetch("http://127.0.0.1:8799/rss").then((r) => r.json()).catch(() => null);
  report.rssKb = rss && typeof rss.rss_kb === "number" ? rss.rss_kb : null;
  report.rounded = {
    coldFirstMs: report.coldFirstMs,
    warmP50: (report.warmReopenMs as { p50: number }).p50,
  };
  return report;
}

export function startBenchIfEnabled(): void {
  if (!enabled()) return;
  const fire = () => {
    void run()
      .then((report) => fetch(ENDPOINT, { method: "POST", body: JSON.stringify(report) }))
      .catch((error) => fetch(ENDPOINT, { method: "POST", body: JSON.stringify({ error: String(error) }) }))
      .catch(() => undefined);
  };
  if (document.readyState === "complete") fire();
  else window.addEventListener("load", fire, { once: true });
}
