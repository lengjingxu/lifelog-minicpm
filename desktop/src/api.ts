import { invoke, convertFileSrc } from "@tauri-apps/api/core";

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
};

export type Facets = {
  tags: [string, number][];
  scenes: [string, number][];
  people: [string, number][];
  months: [string, number][];
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

export const libraryStats = () => invoke<Stats>("library_stats");
export const queryAssets = (filter: Filter) => invoke<Asset[]>("query_assets", { filter });
export const getFacets = () => invoke<Facets>("facets");

export const thumbSrc = (path: string) => (path ? convertFileSrc(path) : "");
