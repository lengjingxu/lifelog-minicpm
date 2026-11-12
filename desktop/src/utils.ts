import type { Asset, Stats } from "./api";

export type View = "library" | "timeline" | "tags" | "people" | "places" | "organize" | "settings";
export type CategoryKind = "tags" | "people" | "places" | "scenes";
export type Drilldown = { kind: CategoryKind; name: string } | null;

export type AssetFilters = {
  tags: string[];
  scene: string | null;
  person: string | null;
  place: string | null;
};

export const GAP = 14;

export function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function timeLabel(value: string | null): string {
  if (!value) return "时间未知";
  const [date, clock] = value.replace("T", " ").split(" ");
  if (!date) return value;
  const [year, month, day] = date.split("-");
  if (!year || !month || !day) return value;
  return `${year} 年 ${Number(month)} 月 ${Number(day)} 日${clock ? ` · ${clock.slice(0, 5)}` : ""}`;
}

export function dayLabel(value: string | null): string {
  if (!value) return "时间未知";
  const [year, month, day] = value.split("-");
  if (!year || !month || !day) return value;
  return `${year} 年 ${Number(month)} 月 ${Number(day)} 日`;
}

export function monthLabel(value: string): string {
  const [year, month] = value.split("-");
  return `${year} 年 ${Number(month)} 月`;
}

export function yearRange(stats: Stats | null): string {
  if (!stats?.first_day || !stats.last_day) return "";
  const from = stats.first_day.slice(0, 4);
  const to = stats.last_day.slice(0, 4);
  return from === to ? from : `${from}–${to}`;
}

export function splitList(value: string | null | undefined): string[] {
  if (!value) return [];
  const cleaned = value.trim();
  if (!cleaned || cleaned === "无" || cleaned === "未知") return [];
  return cleaned
    .split(/[、，,;；/]/)
    .map((item) => item.trim())
    .filter((item) => item && item !== "无" && item !== "未知");
}

export function peopleList(value: string | null | undefined): string[] {
  return splitList(value).filter((item) => item !== "没有");
}

export function kindLabel(asset: Asset): string {
  if (asset.kind === "video") return "视频";
  if (asset.kind === "live" || asset.kind === "live_photo") return "实况";
  if (asset.path.includes("截屏") || asset.path.includes("截图") || asset.tags.includes("屏幕截图")) {
    return "截图";
  }
  return "照片";
}

export function matchesFilters(asset: Asset, filters: AssetFilters): boolean {
  if (filters.tags.length && !filters.tags.every((tag) => asset.tags.includes(tag))) return false;
  if (filters.scene && asset.scene !== filters.scene) return false;
  if (filters.person && !peopleList(asset.people).includes(filters.person)) return false;
  if (filters.place && !splitList(asset.place).includes(filters.place)) return false;
  return true;
}

export function matchesSearch(asset: Asset, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [
    asset.caption,
    asset.scene,
    asset.place,
    asset.people,
    asset.activity,
    asset.mood,
    asset.ocr_text,
    asset.path,
    asset.tags.join(" "),
  ]
    .filter(Boolean)
    .join("\n")
    .toLocaleLowerCase()
    .includes(needle);
}

export type CategoryGroup = {
  name: string;
  count: number;
  cover: Asset;
};

export function buildCategories(assets: Asset[], kind: CategoryKind): CategoryGroup[] {
  const groups = new Map<string, { count: number; cover: Asset }>();
  for (const asset of assets) {
    const names =
      kind === "tags"
        ? asset.tags
        : kind === "people"
          ? peopleList(asset.people)
          : kind === "scenes"
            ? (asset.scene ? [asset.scene] : [])
            : splitList(asset.place);
    for (const name of new Set(names)) {
      const current = groups.get(name);
      if (current) current.count += 1;
      else groups.set(name, { count: 1, cover: asset });
    }
  }
  return [...groups.entries()]
    .map(([name, value]) => ({ name, ...value }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-CN"));
}

export function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function gridColumnCount(viewportWidth: number, density: "comfort" | "compact"): number {
  const requested = density === "compact" ? 8 : 6;
  const minCell = density === "compact" ? 132 : 160;
  // 244 = 侧栏宽，48 = 网格左右 padding 之和（见 DENSITY-LOOSE.md）
  const available = viewportWidth - 244 - 48;
  return Math.max(1, Math.min(requested, Math.floor((available + GAP) / (minCell + GAP))));
}
