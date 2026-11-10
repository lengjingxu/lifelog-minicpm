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
