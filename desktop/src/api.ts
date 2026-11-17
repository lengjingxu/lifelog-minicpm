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
  /** 美学分（0-10），按月查看时用于排序；库里没有评分表时为 null */
  score?: number | null;
  /** 文件字节数 */
  size?: number | null;
  /** 同 size + 同 kind 的图片组里有多少个文件（≥2 才有值）。 */
  dup_count?: number | null;
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
  user_tags?: [string, number][];
  albums: [string, number][];
  scenes: [string, number][];
  people: [string, number][];
  places?: [string, number][];
  months: [string, number][];
};

export type Health = {
  data_dir: string;
  db_exists: boolean;
};

export type Filter = {
  album?: string;
  query?: string;
  tag?: string;
  scene?: string;
  person?: string;
  place?: string;
  kind?: string;
  day_from?: string;
  day_to?: string;
  limit?: number;
  offset?: number;
  /** 深翻页游标：taken_at|id，取上一页最后一条；给了游标就忽略 offset。 */
  cursor?: string;
  /** 排序；按大小排时服务端不用时间游标，走 offset。 */
  sort?: SortKey;
  /** 图库清理的视角：large（默认）/ dup / screenshot / video / photo。 */
  view?: SpaceViewKey;
};

export type SortKey = "taken_desc" | "taken_asc" | "size_desc" | "size_asc";

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

export type DupMember = { asset_id: string; distance: number | null };

export type DupGroup = {
  id: number;
  keeper_id: string;
  reason: string;
  count: number;
  members: DupMember[];
};

type Fixture = {
  stats: Stats;
  assets: Asset[];
  facets: Facets;
  dups?: DupGroup[];
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

/** 去重分组（只读）。老库没有去重表时后端返回空数组。 */
export async function dupGroups(): Promise<DupGroup[]> {
  if (!isTauri) return (await loadFixture()).dups ?? [];
  return invoke<DupGroup[]>("dup_groups");
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
  // 与 Rust query_assets 的 view 过滤保持一致，浏览器 fixture 才能验证五个视角。
  const dupSizes = new Map<number, number>();
  for (const asset of assets) {
    if (asset.kind === "image" && asset.size) dupSizes.set(asset.size, (dupSizes.get(asset.size) ?? 0) + 1);
  }
  const filtered = assets.filter((asset) => {
    if (query && !matchesQuery(asset, query)) return false;
    if (tag && !asset.tags.includes(tag)) return false;
    if (scene && asset.scene !== scene) return false;
    if (filter.person && !(asset.people ?? "").includes(filter.person)) return false;
    if (filter.place && !(asset.place ?? "").includes(filter.place)) return false;
    if (kind && asset.kind !== kind) return false;
    if (filter.view === "dup" && (asset.kind !== "image" || !asset.size || (dupSizes.get(asset.size) ?? 0) < 2)) return false;
    if (filter.view === "screenshot" && !isScreenshot(asset)) return false;
    if (filter.view === "video" && asset.kind !== "video") return false;
    if (filter.view === "photo" && asset.kind === "video") return false;
    if (filter.day_from && (!asset.day || asset.day < filter.day_from)) return false;
    if (filter.day_to && (!asset.day || asset.day > filter.day_to)) return false;
    return true;
  });
  const sorted = (() => {
    switch (filter.sort) {
      case "size_desc":
        return [...filtered].sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
      case "size_asc":
        return [...filtered].sort((a, b) => (a.size ?? 0) - (b.size ?? 0));
      case "taken_asc":
        return [...filtered].sort((a, b) => (a.taken_at ?? "").localeCompare(b.taken_at ?? ""));
      default:
        return filtered;
    }
  })();
  const limit = Math.max(0, filter.limit ?? 500);
  if (filter.cursor && (!filter.sort || filter.sort === "taken_desc")) {
    const id = filter.cursor.split("|")[1];
    const index = filtered.findIndex((asset) => asset.id === id);
    if (index >= 0) return sorted.slice(index + 1, index + 1 + limit);
  }
  const offset = Math.max(0, filter.offset ?? 0);
  return sorted.slice(offset, offset + limit);
}

export async function countAssets(filter: Filter): Promise<number> {
  if (!isTauri) {
    // fixture 只有几十条，这里给个足够大的上限即可，不涉及真实库
    const rows = await fixtureQuery({ ...filter, limit: 100000, offset: 0 });
    return rows.length;
  }
  return invoke<number>("count_assets", { filter });
}

/** 守卫：任何一次取图都不许超过 2000 条，避免再把整库塞进内存（10 万条约 40MB JSON）。 */
export const MAX_PAGE_LIMIT = 2000;

/** Tauri 的 invoke 会把 Rust Option<i64> 的 None 变成 null；这里统一成 number | null。 */
function normalizeSize(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

export async function queryAssets(filter: Filter): Promise<Asset[]> {
  if ((filter.limit ?? 0) > MAX_PAGE_LIMIT) {
    throw new Error("queryAssets limit " + filter.limit + " 超过上限 " + MAX_PAGE_LIMIT + "，请改成分页");
  }
  if (!isTauri) return fixtureQuery(filter);
  const rows = await invoke<Asset[]>("query_assets", { filter });
  return rows.map((row) => ({ ...row, size: normalizeSize(row.size) }));

}

export type MonthSummary = { month: string; count: number; cover_id: string; cover_thumb: string };
export type AlbumSummary = {
  name: string;
  count: number;
  cover_id: string;
  cover_thumb: string;
  preview_thumb: string[];
};
export type GroupSummary = { name: string; count: number; cover_id: string; cover_thumb: string };

const SPLIT_RE = /[、，,;；/]/;

export async function albumGroups(): Promise<AlbumSummary[]> {
  // 相册是本地库里的 album_assets，浏览器 fixture 没有这层，直接返回空。
  if (!isTauri) return [];
  return invoke<AlbumSummary[]>("album_groups");
}

export async function timelineMonths(): Promise<MonthSummary[]> {
  if (!isTauri) {
    const rows = await fixtureQuery({ limit: MAX_PAGE_LIMIT, offset: 0 });
    const map = new Map<string, MonthSummary>();
    for (const asset of rows) {
      const month = asset.day?.slice(0, 7) || "unknown";
      const hit = map.get(month);
      if (hit) hit.count += 1;
      else map.set(month, { month, count: 1, cover_id: asset.id, cover_thumb: asset.thumb });
    }
    return [...map.values()].sort((a, b) => b.month.localeCompare(a.month));
  }
  return invoke<MonthSummary[]>("timeline_months");
}

export async function categoryGroups(kind: "tags" | "people" | "places" | "scenes"): Promise<GroupSummary[]> {
  if (!isTauri) {
    const rows = await fixtureQuery({ limit: MAX_PAGE_LIMIT, offset: 0 });
    const map = new Map<string, GroupSummary>();
    for (const asset of rows) {
      const names =
        kind === "tags"
          ? asset.tags
          : kind === "people"
            ? (asset.people ?? "").split(SPLIT_RE).map((v) => v.trim()).filter((v) => v && v !== "无" && v !== "未知" && v !== "没有")
            : kind === "scenes"
              ? (asset.scene ? [asset.scene] : [])
              : (asset.place ?? "").split(SPLIT_RE).map((v) => v.trim()).filter((v) => v && v !== "无" && v !== "未知");
      for (const name of new Set(names)) {
        const hit = map.get(name);
        if (hit) hit.count += 1;
        else map.set(name, { name, count: 1, cover_id: asset.id, cover_thumb: asset.thumb });
      }
    }
    return [...map.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-CN"));
  }
  return invoke<GroupSummary[]>("category_groups", { kind });
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
  ids?: string[];
}): Promise<LiveStartResult> {
  if (mockSession?.status === "running") {
    return { ok: false, error: "会话进行中，请先暂停或等待完成" };
  }
  awaitFixtureAssets = await loadFixture();
  const wanted = new Set(args.ids ?? []);
  const pool = awaitFixtureAssets.assets.filter(
    (asset) => asset.kind === "image" && (wanted.size === 0 || wanted.has(asset.id)),
  );
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
  ids?: string[];
  force?: boolean;
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

export type ThumbStatus = { assets: number; thumbs: number; full: number; missing: number };

export type ExportSummary = {
  ok: boolean;
  total: number;
  copied: number;
  skipped: number;
  failed: number;
  manifest: string;
  target: string;
};

export const exportAssets = (payload: { ids?: string[]; filter?: Filter; target: string }) =>
  invoke<ExportSummary>("export_assets", { args: payload });

export const revealInFinder = (path: string) => invoke<void>("reveal_in_finder", { path });

/** 用系统默认播放器 / 预览打开：WebView 解不了的视频格式走这里。 */
export const openExternal = (path: string) => invoke<void>("open_external", { path });

/** 清理只把文件移进废纸篓，不给假的撤销；这里只是把废纸篓打开给人自己找。 */
export const openTrash = () =>
  isTauri ? invoke<void>("reveal_in_finder", { path: "~/.Trash" }).catch(() => undefined) : Promise.resolve();

export type DeleteResult = {
  ok: boolean;
  requested: number;
  removed: { captions: number; asset_tags: number; album_assets: number; assets: number };
  /** 原图移到废纸篓的结果；failed 非空时后端会整体失败、不会删记录 */
  files?: { requested: number; trashed: number; missing: number; failed: string[] };
  days_rebuilt?: number;
  events_rebuilt?: number;
};

/** 把删除失败原文（Tauri 抛的是字符串）转成能看懂的一句，授权问题带上该去哪儿开 */
export function describeDeleteError(reason: unknown): string {
  const raw = typeof reason === "string" ? reason : reason instanceof Error ? reason.message : String(reason);
  if (/Operation not permitted|permission|权限|NSPOSIXErrorDomain Code=1/i.test(raw)) {
    return "没有权限移动这些原图。请在「系统设置 → 隐私与安全性 → 文件与文件夹」里给拾光打开所在的磁盘，或打开「完全磁盘访问权限」后重启拾光。";
  }
  return raw.replace(/^Error:\s*/, "");
}

export type LibraryRoot = { root: string; exists: boolean; readable: boolean; assets: number };
export type LibraryAccess = { roots: LibraryRoot[] };

/** 库里照片所在的顶层目录能不能读：被 TCC 拒绝时这里就是 false。 */
export const libraryAccess = () => invoke<LibraryAccess>("library_access");
export const openPrivacySettings = () => invoke<void>("open_privacy_settings");

export const deleteRecords = (ids: string[], withFiles = false) =>
  invoke<DeleteResult>("delete_records", { ids, withFiles });

export type SpaceViewKey = "large" | "dup" | "screenshot" | "video" | "photo";

export type SpaceViewStat = {
  count: number;
  bytes: number;
  /** 仅重复图视角：组数 */
  groups?: number;
  /** 仅重复图视角：keeper 以外的可回收字节 */
  reclaim?: number;
  /** 指纹是否已算完（dup_groups/dup_members 非空） */
  ready?: boolean;
  /** 口径说明 */
  rule?: string;
};

export type SpaceViews = Record<SpaceViewKey, SpaceViewStat>;

export type SpaceGroup = {
  key: string;
  label: string;
  count: number;
  bytes?: number;
  ids?: string[];
  /** 仅重复图：keeper 以外的成员体积合计（可回收） */
  reclaim_bytes?: number;
  /** 原始 reason，例如 burst+l1 */
  reason?: string;
  /** 拆开的判定：burst / l0 / l1 */
  reasons?: string[];
  /** 重复图组内保留的那一张（不默认勾选、永不进待清理） */
  keep?: string | null;
};

export type SpaceGroups = { view: string; groups: SpaceGroup[] };

export type CleanupEntry = {
  asset_id: string;
  added_at: string;
  source: string;
  path: string;
  day: string | null;
  taken_at: string | null;
  kind: string | null;
  size: number | null;
  thumb?: string;
};

export type CleanupList = { items: CleanupEntry[]; count: number; bytes: number };
export type CleanupChange = { changed: number; count: number; bytes: number };

export type SpaceSummary = {
  assets: number;
  bytes: number;
  photos: { count: number; bytes: number };
  videos: { count: number; bytes: number };
  big_videos: { count: number; bytes: number };
  queue_count: number;
  queue_bytes: number;
};

// 浏览器 fixture 没有后端表，用内存队列把「加入 / 移出」跑通，方便预览与截图。
let fixtureQueue: CleanupEntry[] = [];

function fixtureEntry(asset: Asset): CleanupEntry {
  return {
    asset_id: asset.id,
    added_at: String(Math.floor(Date.now() / 1000)),
    source: "space",
    path: asset.path,
    day: asset.day,
    taken_at: asset.taken_at,
    kind: asset.kind,
    size: asset.size ?? null,
    thumb: asset.thumb,
  };
}

function fixtureQueueList(): CleanupList {
  return {
    items: fixtureQueue,
    count: fixtureQueue.length,
    bytes: fixtureQueue.reduce((sum, item) => sum + (item.size ?? 0), 0),
  };
}

export async function cleanupList(): Promise<CleanupList> {
  if (!isTauri) return fixtureQueueList();
  return invoke<CleanupList>("cleanup_list");
}

export async function cleanupAdd(ids: string[], source = "space"): Promise<CleanupChange> {
  if (!isTauri) {
    const { assets } = await loadFixture();
    const known = new Map(assets.map((asset) => [asset.id, asset]));
    let changed = 0;
    for (const id of ids) {
      if (fixtureQueue.some((item) => item.asset_id === id)) continue;
      const asset = known.get(id);
      if (!asset) continue;
      fixtureQueue = [fixtureEntry(asset), ...fixtureQueue];
      changed += 1;
    }
    return { changed, ...fixtureQueueList() };
  }
  return invoke<CleanupChange>("cleanup_add", { ids, source });
}

export async function cleanupRemove(ids: string[]): Promise<CleanupChange> {
  if (!isTauri) {
    const drop = new Set(ids);
    fixtureQueue = fixtureQueue.filter((item) => !drop.has(item.asset_id));
    return { changed: ids.length, ...fixtureQueueList() };
  }
  return invoke<CleanupChange>("cleanup_remove", { ids });
}

export async function spaceViews(): Promise<SpaceViews> {
  if (!isTauri) {
    const { assets } = await loadFixture();
    const stat = (list: Asset[]) => ({
      count: list.length,
      bytes: list.reduce((sum, asset) => sum + (asset.size ?? 0), 0),
    });
    const sizes = new Map<number, number>();
    for (const asset of assets) {
      if (asset.kind === "image" && asset.size) sizes.set(asset.size, (sizes.get(asset.size) ?? 0) + 1);
    }
    const dupSizes = [...sizes.values()].filter((n) => n > 1);
    const dupCount = dupSizes.reduce((sum, n) => sum + n, 0);
    const dupAssets = assets.filter(
      (asset) => asset.kind === "image" && asset.size && (sizes.get(asset.size) ?? 0) > 1,
    );
    const dupBytes = dupAssets.reduce((sum, asset) => sum + (asset.size ?? 0), 0);
    const reclaim = dupSizes.reduce((sum, n) => sum + (n - 1), 0);
    const screenshot = assets.filter((asset) => isScreenshot(asset));
    return {
      large: stat(assets),
      video: stat(assets.filter((asset) => asset.kind === "video")),
      photo: stat(assets.filter((asset) => asset.kind !== "video")),
      screenshot: { ...stat(screenshot), rule: "路径 + scene/tags" },
      dup: { count: dupCount, groups: dupSizes.length, bytes: dupBytes, reclaim, ready: true, rule: "dhash 指纹（fixture 近似）" },
    };
  }
  return invoke<SpaceViews>("space_views");
}

function isScreenshot(asset: Asset): boolean {
  const path = asset.path ?? "";
  if (/Screenshot|screenshot|截屏|屏幕/.test(path)) return true;
  const scene = asset.scene ?? "";
  const tags = asset.tags.join(" ");
  return /屏幕|截屏/.test(scene) || /屏幕截图|截屏/.test(tags);
}

/** 触发一次 dedup --build（真实算 dhash 并重建分组）。 */
export async function dedupBuild(): Promise<unknown> {
  if (!isTauri) throw new Error("浏览器预览里不能计算指纹，请在桌面端使用");
  return invoke<unknown>("dedup_build");
}

export async function spaceGroups(view: SpaceViewKey): Promise<SpaceGroups> {
  if (!isTauri) {
    const { assets } = await loadFixture();
    if (view === "dup") {
      // 浏览器 fixture 没有 dhash：用「同 size 同 kind」近似真实组，保持结构一致（keeper + 其余）。
      const bySize = new Map<number, Asset[]>();
      for (const asset of assets) {
        if (asset.kind !== "image" || !asset.size) continue;
        bySize.set(asset.size, [...(bySize.get(asset.size) ?? []), asset]);
      }
      const groups: SpaceGroup[] = [...bySize.entries()]
        .filter(([, list]) => list.length > 1)
        .map(([size, list]) => {
          const sorted = [...list].sort((a, b) => (a.taken_at ?? "").localeCompare(b.taken_at ?? ""));
          const keeper = sorted[0];
          return {
            key: `dup:${size}`,
            label: "像素近似",
            reason: "l1",
            reasons: ["l1"],
            count: sorted.length,
            bytes: sorted.reduce((sum, asset) => sum + (asset.size ?? 0), 0),
            reclaim_bytes: sorted.slice(1).reduce((sum, asset) => sum + (asset.size ?? 0), 0),
            ids: sorted.map((asset) => asset.id),
            keep: keeper.id,
          };
        });
      return { view, groups };
    }
    if (view === "screenshot") {
      const buckets = new Map<string, Asset[]>();
      for (const asset of assets.filter(isScreenshot)) {
        const marker = (asset.path ?? "").indexOf("/photos/");
        const relative = marker >= 0 ? asset.path.slice(marker + 8) : asset.path;
        const parts = relative.split("/").filter(Boolean);
        const label = parts.length > 1 ? parts[0] : relative.split("/").slice(-2, -1)[0] ?? "其他";
        buckets.set(label, [...(buckets.get(label) ?? []), asset]);
      }
      return {
        view,
        groups: [...buckets.entries()].map(([label, list]) => ({
          key: `screenshot:${label}`,
          label,
          count: list.length,
          bytes: list.reduce((sum, asset) => sum + (asset.size ?? 0), 0),
          ids: list.map((asset) => asset.id),
        })),
      };
    }
    return { view, groups: [] };
  }
  return invoke<SpaceGroups>("space_groups", { view });
}

export type SpaceVersions = { assets: number; bytes: number; version: string };

export async function spaceVersions(): Promise<SpaceVersions> {
  if (!isTauri) {
    const { assets } = await loadFixture();
    return {
      assets: assets.length,
      bytes: assets.reduce((sum, asset) => sum + (asset.size ?? 0), 0),
      version: "fixture",
    };
  }
  return invoke<SpaceVersions>("space_versions");
}

export async function spaceSummary(): Promise<SpaceSummary> {
  if (!isTauri) {
    const { assets } = await loadFixture();
    const photos = assets.filter((asset) => asset.kind !== "video");
    const videos = assets.filter((asset) => asset.kind === "video");
    const add = (list: Asset[]) => ({
      count: list.length,
      bytes: list.reduce((sum, asset) => sum + (asset.size ?? 0), 0),
    });
    const photoStats = add(photos);
    const videoStats = add(videos);
    const big = add(videos.filter((asset) => (asset.size ?? 0) >= 104857600));
    const queue = fixtureQueueList();
    return {
      assets: assets.length,
      bytes: photoStats.bytes + videoStats.bytes,
      photos: photoStats,
      videos: videoStats,
      big_videos: big,
      queue_count: queue.count,
      queue_bytes: queue.bytes,
    };
  }
  return invoke<SpaceSummary>("space_summary");
}

export type ImportPlan = {
  listed: number;
  new: number;
  existing: number;
  bytes: number;
  stage?: string;
};

export const importXiaomi = (dryRun: boolean) => invoke<ImportPlan>("import_xiaomi", { dryRun });

export const thumbStatus = () => invoke<ThumbStatus>("thumb_status");
export const generateThumbs = (force = false) => invoke<{ ok: boolean }>("generate_thumbs", { force });

import { open } from "@tauri-apps/plugin-dialog";

export const pickFolder = async (options?: { title?: string; defaultPath?: string }): Promise<string | null> => {
  const picked = await open({
    directory: true,
    multiple: false,
    title: options?.title ?? "选择要导入的文件夹",
    defaultPath: options?.defaultPath,
  });
  return typeof picked === "string" ? picked : null;
};

export const importFolder = (path: string) => invoke<{ ok: boolean; stats?: unknown }>("import_folder", { path });

export type Album = { id: string; name: string; count: number };

export const bulkTag = (ids: string[], tag: string, remove = false) =>
  invoke<{ ok: boolean; added?: number; removed?: number }>("bulk_tag", { ids, tag, remove });

export const albumList = () => invoke<{ ok: boolean; albums: Album[] }>("album_list");
export const albumCreate = (name: string) => invoke<{ ok: boolean; album: Album }>("album_create", { name });
export const albumAdd = (name: string, ids: string[], remove = false) =>
  invoke<{ ok: boolean; added?: number; removed?: number }>("album_add", { name, ids, remove });
