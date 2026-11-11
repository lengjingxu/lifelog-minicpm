import { convertFileSrc, invoke } from "@tauri-apps/api/core";

export type Asset = {
  id: string;
  path: string;
  thumb: string;
  original: string;
  day: string | null;
  taken_at: string | null;
  kind: string | null;
  caption: string | null;
  scene: string | null;
  people: string | null;
  place: string | null;
  activity: string | null;
  mood: string | null;
  tags: string[];
  ocr_text: string | null;
};

export type Stats = {
  assets: number;
  captions: number;
  days: number;
  events: number;
  first_day: string | null;
  last_day: string | null;
  db_path: string;
  db_size?: number;
};

export type Facets = {
  tags: [string, number][];
  scenes: [string, number][];
  people: [string, number][];
  months: [string, number][];
};

export type Health = {
  data_dir: string;
  db_exists: boolean;
};

export type Filter = {
  query?: string;
  tag?: string;
  scene?: string;
  kind?: string;
  day_from?: string;
  day_to?: string;
  limit?: number;
  offset?: number;
};

export type LiveStatus = "running" | "done" | "stopped" | "idle";

export type LiveState = {
  mode: string | null;
  status: LiveStatus;
  total: number;
  done: number;
  concurrency: number;
  elapsed_ms: number;
  rate: number | null;
  extra: Record<string, unknown>;
};

export type LiveEventType = "start" | "done" | "error" | "session_done" | "session_stopped";

export type LiveEvent = {
  seq: number;
  type: LiveEventType;
  asset_id?: string;
  slot?: number;
  elapsed_ms?: number;
  tags?: string[];
  caption?: string;
  message?: string;
  done?: number;
  total?: number;
};

export type LivePhoto = { id: string; thumb: string };

export type LiveStartResult = {
  ok: boolean;
  state?: LiveState;
  photos?: LivePhoto[];
  error?: string;
};

export type LiveHealth = {
  ok: boolean;
  port?: number;
  label?: string;
  state?: LiveState;
  error?: string;
};

export type ThumbCacheInfo = { path: string; size: number; count: number };

export type AppSettings = {
  data_dir: string;
  db_path: string;
  db_size: number;
  data_size: number;
  data_files: number;
  thumb_cache: ThumbCacheInfo;
  model: { key: string; title: string; path: string; available: boolean; role: string };
  xiaomi: { logged_in: boolean; token_dir: string; detail: string };
  read_only: boolean;
};

export type RebuildResult = { ok: boolean; code?: number | null; stdout?: string; stderr?: string };

type Fixture = {
  stats: Stats;
  assets: Asset[];
  facets: Facets;
};

type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown };

export const isTauri =
  typeof window !== "undefined" && Boolean((window as TauriWindow).__TAURI_INTERNALS__);

export const isFixture = !isTauri;

let fixturePromise: Promise<Fixture> | null = null;

function loadFixture(): Promise<Fixture> {
  if (!fixturePromise) {
    fixturePromise = fetch("/sample-fixture.json", { cache: "no-cache" }).then((response) => {
      if (!response.ok) throw new Error(`示例数据加载失败：HTTP ${response.status}`);
      return response.json() as Promise<Fixture>;
    });
  }
  return fixturePromise;
}

function fixtureAssetUrl(path: string): string {
  if (!path) return "";
  if (/^(https?:|data:|blob:|\/\/)/.test(path)) return path;
  const relative = path.replace(/^\/+/, "");
  return `/__fixture/${relative.split("/").map(encodeURIComponent).join("/")}`;
}

/** Resolve an image path for the current runtime. Never fetches image bytes over IPC. */
export function assetSrc(path: string): string {
  if (!path) return "";
  if (!isTauri) return fixtureAssetUrl(path);
  if (/^(https?:|data:|blob:|asset:)/.test(path)) return path;
  return convertFileSrc(path);
}

/** Kept for older call sites: thumbnails are resolved by the same runtime switch. */
export const thumbSrc = assetSrc;

export async function libraryStats(): Promise<Stats> {
  if (!isTauri) return (await loadFixture()).stats;
  return invoke<Stats>("library_stats");
}

export async function getFacets(): Promise<Facets> {
  if (!isTauri) return (await loadFixture()).facets;
  return invoke<Facets>("facets");
}

export async function health(): Promise<Health> {
  if (!isTauri) return { data_dir: "sample-data", db_exists: true };
  return invoke<Health>("health");
}

function matchesQuery(asset: Asset, query: string): boolean {
  const needle = query.toLocaleLowerCase();
  const haystack = [
    asset.caption,
    asset.scene,
    asset.place,
    asset.ocr_text,
    asset.path,
    asset.people,
    asset.activity,
    asset.mood,
    asset.tags.join(" "),
  ]
    .filter(Boolean)
    .join("\n")
    .toLocaleLowerCase();
  return haystack.includes(needle);
}

async function fixtureQuery(filter: Filter): Promise<Asset[]> {
  const { assets } = await loadFixture();
  const query = filter.query?.trim() ?? "";
  const tag = filter.tag?.trim() ?? "";
  const scene = filter.scene?.trim() ?? "";
  const kind = filter.kind?.trim() ?? "";
  const filtered = assets.filter((asset) => {
    if (query && !matchesQuery(asset, query)) return false;
    if (tag && !asset.tags.includes(tag)) return false;
    if (scene && asset.scene !== scene) return false;
    if (kind && asset.kind !== kind) return false;
    if (filter.day_from && (!asset.day || asset.day < filter.day_from)) return false;
    if (filter.day_to && (!asset.day || asset.day > filter.day_to)) return false;
    return true;
  });
  const offset = Math.max(0, filter.offset ?? 0);
  const limit = Math.max(0, filter.limit ?? 500);
  return filtered.slice(offset, offset + limit);
}

export async function queryAssets(filter: Filter): Promise<Asset[]> {
  if (!isTauri) return fixtureQuery(filter);
  return invoke<Asset[]>("query_assets", { filter });
}

/* ------------------------------------------------------------------ */
/* Live recognition adapter                                           */
/* ------------------------------------------------------------------ */

type MockSession = {
  status: LiveStatus;
  mode: string;
  total: number;
  done: number;
  failed: number;
  concurrency: number;
  speed: number;
  startedAt: number;
  finishedAt: number | null;
  events: LiveEvent[];
  photos: LivePhoto[];
  queue: string[];
  active: Map<number, string>;
  freeSlots: number[];
  timers: Set<number>;
  stopped: boolean;
  seq: number;
};

let mockSession: MockSession | null = null;

export type LiveFailure = Error & { code?: string; service?: string };

function normalizeLiveError(reason: unknown): LiveFailure {
  if (reason instanceof Error) return reason as LiveFailure;
  if (reason && typeof reason === "object") {
    const shape = reason as { message?: unknown; code?: unknown; service?: unknown };
    const message = typeof shape.message === "string" ? shape.message : "识别服务未启动";
    const error = new Error(message) as LiveFailure;
    if (typeof shape.code === "string") error.code = shape.code;
    if (typeof shape.service === "string") error.service = shape.service;
    return error;
  }
  return new Error(String(reason)) as LiveFailure;
}

async function invokeLive<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (reason) {
    throw normalizeLiveError(reason);
  }
}

function liveIdle(): LiveState {
  return {
    mode: null,
    status: "idle",
    total: 0,
    done: 0,
    concurrency: 0,
    elapsed_ms: 0,
    rate: null,
    extra: {},
  };
}

function mockState(session: MockSession | null): LiveState {
  if (!session) return liveIdle();
  const elapsed = (session.finishedAt ?? Date.now()) - session.startedAt;
  return {
    mode: session.mode,
    status: session.status,
    total: session.total,
    done: session.done,
    concurrency: session.concurrency,
    elapsed_ms: elapsed,
    rate: elapsed > 400 ? Math.round((session.done / (elapsed / 1000)) * 100) / 100 : null,
    extra: { speed: session.speed, label: "浏览器 fixture · 模拟事件流", failed: session.failed },
  };
}

function mockPush(session: MockSession, event: Omit<LiveEvent, "seq">): void {
  session.seq += 1;
  session.events.push({ ...event, seq: session.seq });
}

function mockFinish(session: MockSession, status: "done" | "stopped"): void {
  if (session.status !== "running") return;
  session.status = status;
  session.finishedAt = Date.now();
  session.active.clear();
  for (const timer of session.timers) window.clearTimeout(timer);
  session.timers.clear();
  mockPush(session, {
    type: status === "done" ? "session_done" : "session_stopped",
    done: session.done,
    total: session.total,
  });
}

function mockPump(session: MockSession): void {
  if (session.status !== "running" || session.stopped) return;
  while (session.active.size < session.concurrency && session.queue.length > 0) {
    const assetId = session.queue.shift();
    if (!assetId) break;
    const slot = session.freeSlots.shift() ?? session.active.size;
    session.active.set(slot, assetId);
    mockPush(session, { type: "start", asset_id: assetId, slot });
    const elapsed = (2400 + Math.random() * 2200) / Math.max(0.25, session.speed);
    const timer = window.setTimeout(() => {
      session.timers.delete(timer);
      if (session.status !== "running" || session.stopped) return;
      session.active.delete(slot);
      session.freeSlots.push(slot);
      const processed = session.done + session.failed;
      const failsThisOne = processed > 0 && processed % 9 === 5;
      if (failsThisOne) {
        session.failed += 1;
        mockPush(session, {
          type: "error",
          asset_id: assetId,
          slot,
          elapsed_ms: Math.round(elapsed),
          message: "模拟的单张识别失败（未归类）",
        });
      } else {
        session.done += 1;
        const { assets } = awaitFixtureAssets;
        const asset = assets.find((item) => item.id === assetId);
        mockPush(session, {
          type: "done",
          asset_id: assetId,
          slot,
          elapsed_ms: Math.round(elapsed),
          tags: asset?.tags ?? [],
          caption: asset?.caption ?? "",
        });
      }
      if (session.queue.length === 0 && session.active.size === 0) {
        mockFinish(session, "done");
      } else {
        mockPump(session);
      }
    }, elapsed);
    session.timers.add(timer);
  }
}

/** Cache used by the mock scheduler so it can attach real fixture tags to events. */
let awaitFixtureAssets: Fixture = { stats: {} as Stats, assets: [], facets: {} as Facets };

async function mockStart(args: {
  mode?: string;
  count?: number;
  concurrency?: number;
  speed?: number;
}): Promise<LiveStartResult> {
  if (mockSession?.status === "running") {
    return { ok: false, error: "会话进行中，请先暂停或等待完成" };
  }
  awaitFixtureAssets = await loadFixture();
  const pool = awaitFixtureAssets.assets.filter((asset) => asset.kind === "image");
  const requested = Math.max(1, Math.min(args.count ?? 24, pool.length));
  const shuffled = [...pool].sort(() => Math.random() - 0.5).slice(0, requested);
  const photos = shuffled.map((asset) => ({ id: asset.id, thumb: `thumbs/${asset.id}.jpg` }));
  const session: MockSession = {
    status: "running",
    mode: args.mode ?? "sim",
    total: photos.length,
    done: 0,
    failed: 0,
    concurrency: Math.max(1, Math.min(8, args.concurrency ?? 4)),
    speed: Math.max(0.25, args.speed ?? 2),
    startedAt: Date.now(),
    finishedAt: null,
    events: [],
    photos,
    queue: photos.map((photo) => photo.id),
    active: new Map(),
    freeSlots: Array.from({ length: Math.max(1, Math.min(8, args.concurrency ?? 4)) }, (_, i) => i),
    timers: new Set(),
    stopped: false,
    seq: 0,
  };
  mockSession = session;
  mockPump(session);
  return { ok: true, state: mockState(session), photos };
}

export async function liveHealth(): Promise<LiveHealth> {
  if (!isTauri) {
    return {
      ok: true,
      label: "浏览器 fixture · 模拟事件流",
      state: mockState(mockSession),
    };
  }
  return invokeLive<LiveHealth>("live_health");
}

export async function liveStart(args: {
  mode?: string;
  count?: number;
  concurrency?: number;
  speed?: number;
}): Promise<LiveStartResult> {
  if (!isTauri) return mockStart(args);
  return invokeLive<LiveStartResult>("live_start", { args });
}

export async function liveState(): Promise<LiveState> {
  if (!isTauri) return mockState(mockSession);
  return invokeLive<LiveState>("live_state");
}

export async function liveEvents(cursor: number): Promise<{ events: LiveEvent[]; cursor: number }> {
  if (!isTauri) {
    if (!mockSession) return { events: [], cursor: 0 };
    return { events: mockSession.events.slice(cursor), cursor: mockSession.events.length };
  }
  return invokeLive<{ events: LiveEvent[]; cursor: number }>("live_events", { cursor });
}

export async function liveStop(): Promise<{ ok: boolean; error?: string }> {
  if (!isTauri) {
    if (!mockSession || mockSession.status !== "running") {
      return { ok: false, error: "没有进行中的会话" };
    }
    mockSession.stopped = true;
    mockFinish(mockSession, "stopped");
    return { ok: true };
  }
  return invokeLive<{ ok: boolean; error?: string }>("live_stop");
}

export async function livePhotos(): Promise<LivePhoto[]> {
  if (!isTauri) return mockSession?.photos ?? [];
  return invokeLive<LivePhoto[]>("live_photos");
}

export async function appSettings(): Promise<AppSettings> {
  if (!isTauri) {
    const { stats } = await loadFixture();
    return {
      data_dir: "/Users/leng/lifelog-minicpm/desktop/sample-data",
      db_path: stats.db_path,
      db_size: stats.db_size ?? 69632,
      data_size: 12_582_912,
      data_files: 75,
      thumb_cache: { path: "sample-data/thumbs", size: 3_355_443, count: 48 },
      model: {
        key: "minicpm-v-4.7-1b",
        title: "MiniCPM-V-4.7-1B",
        path: "/Volumes/Leng/Models/minicpm-v-4.7-1b",
        available: true,
        role: "全库识别 · 端侧 MiniCPM",
      },
      xiaomi: {
        logged_in: true,
        token_dir: "~/.xiaomi-token",
        detail: "检测到 ~/.xiaomi-token/token.mjs（fixture）",
      },
      read_only: true,
    };
  }
  return invoke<AppSettings>("app_settings");
}

export async function rebuildThumbs(): Promise<RebuildResult> {
  if (!isTauri) {
    throw new Error("浏览器 fixture 不执行缩略图重建，请在桌面端使用");
  }
  return invoke<RebuildResult>("rebuild_thumbs");
}
