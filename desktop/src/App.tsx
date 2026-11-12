import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { listen } from "@tauri-apps/api/event";
import { AlertCircle, LoaderCircle, Search, X } from "lucide-react";
import {
  getFacets,
  health,
  isFixture,
  libraryStats,
  queryAssets,
  countAssets,
  type Asset,
  type Facets,
  type Health,
  type Stats,
  pickFolder,
  importFolder,
  isTauri,
  importXiaomi,
  generateThumbs,
  bulkTag,
  exportAssets,
  deleteRecords,
  revealInFinder,
  albumAdd,
} from "./api";
import { Sidebar } from "./components/Sidebar";
import { Topbar } from "./components/Topbar";
import { VirtualGrid } from "./components/VirtualGrid";
import { Timeline } from "./components/Timeline";
import { Categories } from "./components/Categories";
import { Detail } from "./components/Detail";
import { SelectionBar } from "./components/SelectionBar";
import { ImportDialog, type ImportPlan, type ImportProgress } from "./components/ImportDialog";
import { DeleteDialog } from "./components/DeleteDialog";
import { EmptyState } from "./components/EmptyState";
import { OrganizeView } from "./components/OrganizeView";
import { RecognitionDialog } from "./components/RecognitionDialog";
import { SettingsView } from "./components/SettingsView";
import { useLiveController } from "./live";
import {
  buildCategories,
  gridColumnCount,
  matchesFilters,
  matchesSearch,
  peopleList,
  splitList,
  unique,
  yearRange,
  type CategoryKind,
  type Drilldown,
  type View,
} from "./utils";

type Density = "comfort" | "compact";

const PAGE_SIZE = 200;
const ALL_LIMIT = 100000;
const APP_START = performance.now();

function readRoute() {
  const params = new URLSearchParams(window.location.search);
  const requestedView = params.get("view");
  const view: View =
    requestedView === "timeline" ||
    requestedView === "tags" ||
    requestedView === "people" ||
    requestedView === "places" ||
    requestedView === "organize" ||
    requestedView === "settings"
      ? requestedView
      : "library";
  return {
    view,
    query: params.get("q")?.trim() ?? "",
    assetId: params.get("asset"),
    tags: (params.get("tag") ?? "").split(",").map((tag) => tag.trim()).filter(Boolean),
    person: params.get("person"),
    place: params.get("place"),
    density: (params.get("density") === "compact" ? "compact" : "comfort") as Density,
    modal: params.get("modal"),
    demo: params.get("demo"),
    demoSpeed: Number(params.get("speed") ?? 0),
    demoCount: Number(params.get("count") ?? 0),
  };
}

const CATEGORY_LABEL: Record<CategoryKind, string> = {
  tags: "标签",
  people: "人物",
  places: "地点",
  scenes: "场景",
};

function extractMessage(err: unknown): string {
  const raw = String(err);
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.message === "string") return parsed.message;
  } catch {
    // 不是 JSON 就原样返回
  }
  return raw;
}

export default function App() {
  type ToastAction = { label: string; run: () => void };
type ToastState = { text: string; action?: ToastAction };

const route = useMemo(readRoute, []);
  const [view, setView] = useState<View>(route.query ? "library" : route.view);
  const [drilldown, setDrilldown] = useState<Drilldown>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [facets, setFacets] = useState<Facets | null>(null);
  const [healthInfo, setHealthInfo] = useState<Health | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [allAssets, setAllAssets] = useState<Asset[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [allLoading, setAllLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [queryInput, setQueryInput] = useState(route.query);
  const [query, setQuery] = useState(route.query);
  const [tags, setTags] = useState<string[]>(route.tags);
  const [scene, setScene] = useState<string | null>(null);
  const [person, setPerson] = useState<string | null>(route.person);
  const [place, setPlace] = useState<string | null>(route.place);
  const [density, setDensity] = useState<Density>(route.density);
  const [selection, setSelection] = useState<string[]>(route.assetId ? [route.assetId] : []);
  const [anchorId, setAnchorId] = useState<string | null>(route.assetId);
  const [detailId, setDetailId] = useState<string | null>(route.assetId);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [dialogOrigin, setDialogOrigin] = useState<string>("50% 100%");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [album, setAlbum] = useState<string | null>(null);
  const [detailClosing, setDetailClosing] = useState(false);
  const [dialogClosing, setDialogClosing] = useState(false);
  const [detailOrigin, setDetailOrigin] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  // ?theme=dark|light 只影响本次会话（测量/截图用），不覆盖用户偏好。
  const forcedTheme = useRef<"dark" | "light" | null>(
    (() => {
      const value = new URLSearchParams(window.location.search).get("theme");
      return value === "dark" || value === "light" ? value : null;
    })(),
  ).current;
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    if (forcedTheme) return forcedTheme;
    const saved = localStorage.getItem("sg-theme");
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    if (!forcedTheme) localStorage.setItem("sg-theme", theme);
  }, [theme, forcedTheme]);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [recognitionOpen, setRecognitionOpen] = useState(route.modal === "recognize");
  const live = useLiveController();
  const demoStarted = useRef(false);

  const searchRef = useRef<HTMLInputElement>(null);
  const searchTimer = useRef<number | null>(null);
  const toastTimer = useRef<number | null>(null);
  const [dataVersion, setDataVersion] = useState(0);
  // 浏览器 fixture 模式下没有后端，用本地覆盖层模拟「已移除」，撤销时回滚。
  const [localRemoved, setLocalRemoved] = useState<Record<string, string[]>>({});
  const pendingUndo = useRef<{ revert: () => Promise<void> } | null>(null);
  // fixture 模式下没有后端相册，用本地成员表撑起相册视图与「移出」。
  const [fixtureAlbums, setFixtureAlbums] = useState<Record<string, string[]>>({});
  const [fixtureUserTags, setFixtureUserTags] = useState<Record<string, string[]>>({});
  const pendingSearch = useRef<{ start: number; value: string } | null>(null);
  const firstGridMarked = useRef(false);

  const tagKey = tags.join("\u0001");
  const active = Boolean(query || tags.length || scene || person || place || album);
  const columns = gridColumnCount(viewportWidth, density);

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const showToast = useCallback((message: string, action?: ToastAction) => {
    setToast({ text: message, action });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), action ? 5000 : 2400);
  }, []);

  const refreshData = useCallback(() => {
    getFacets().then(setFacets).catch(() => undefined);
    // 统计也要刷：删掉记录后侧栏「全部照片」不能还显示旧数字。
    libraryStats().then(setStats).catch(() => undefined);
    setDataVersion((version) => version + 1);
  }, []);

  const setLocalRemoval = useCallback((scope: string, ids: string[], removed: boolean) => {
    setLocalRemoved((previous) => {
      const next = new Set(previous[scope] ?? []);
      ids.forEach((id) => (removed ? next.add(id) : next.delete(id)));
      return { ...previous, [scope]: Array.from(next) };
    });
  }, []);

  const userTagNames = useMemo(() => {
    const names = new Set((facets?.user_tags ?? []).map(([name]) => name));
    Object.keys(fixtureUserTags).forEach((name) => names.add(name));
    return names;
  }, [facets, fixtureUserTags]);

  const displayFacets = useMemo(() => {
    if (!facets || !isFixture) return facets;
    const subtract = (list: [string, number][] | undefined, prefix: string): [string, number][] =>
      (list ?? []).map(([name, count]) => [
        name,
        Math.max(0, count - (localRemoved[`${prefix}:${name}`]?.length ?? 0)),
      ]);
    const baseAlbums = subtract(facets.albums, "album");
    const localAlbums: [string, number][] = Object.entries(fixtureAlbums).map(([name, ids]) => [
      name,
      ids.filter((id) => !(localRemoved[`album:${name}`] ?? []).includes(id)).length,
    ]);
    const merged = new Map<string, number>(baseAlbums);
    localAlbums.forEach(([name, count]) => merged.set(name, count));
    const baseUserTags = subtract(facets.user_tags, "tag");
    const localUserTags: [string, number][] = Object.entries(fixtureUserTags).map(([name, ids]) => [
      name,
      ids.filter((id) => !(localRemoved[`tag:${name}`] ?? []).includes(id)).length,
    ]);
    const userMerged = new Map<string, number>(baseUserTags);
    localUserTags.forEach(([name, count]) => userMerged.set(name, count));
    return {
      ...facets,
      tags: subtract(facets.tags, "tag"),
      user_tags: Array.from(userMerged.entries()),
      albums: Array.from(merged.entries()),
    };
  }, [facets, localRemoved, fixtureAlbums, fixtureUserTags]);

  const runRemove = useCallback(
    async (kind: "tag" | "album", value: string) => {
      if (!selection.length || bulkBusy) return;
      const ids = [...selection];
      const scope = `${kind}:${value}`;
      setBulkBusy(true);
      try {
        if (isFixture) {
          setLocalRemoval(scope, ids, true);
        } else if (kind === "tag") {
          await bulkTag(ids, value, true);
        } else {
          await albumAdd(value, ids, true);
        }

        // 上一次未撤销的那批直接提交（丢弃 undo 句柄），符合「后一次覆盖前一次」。
        pendingUndo.current = {
          revert: async () => {
            if (isFixture) {
              setLocalRemoval(scope, ids, false);
            } else if (kind === "tag") {
              await bulkTag(ids, value, false);
            } else {
              await albumAdd(value, ids, false);
            }
            refreshData();
          },
        };

        refreshData();
        setSelection([]);
        const message =
          kind === "tag"
            ? `已从 ${ids.length} 张移除标签「${value}」`
            : `已从相册「${value}」移出 ${ids.length} 张`;
        showToast(message, {
          label: "撤销",
          run: () => {
            const undo = pendingUndo.current;
            pendingUndo.current = null;
            if (!undo) return;
            void undo.revert().then(
              () => showToast("已撤销"),
              (err: unknown) => showToast(`撤销失败：${String(err)}`),
            );
          },
        });
      } catch (err) {
        showToast(`移除失败：${String(err)}`);
      } finally {
        setBulkBusy(false);
      }
    },
    [selection, bulkBusy, refreshData, setLocalRemoval, showToast],
  );

  const runBulk = async (kind: "tag" | "album", value: string) => {
    if (!selection.length || bulkBusy) return;
    setBulkBusy(true);
    try {
      if (kind === "tag") {
        if (isFixture) {
          setFixtureUserTags((previous) => ({
            ...previous,
            [value]: Array.from(new Set([...(previous[value] ?? []), ...selection])),
          }));
        } else {
          await bulkTag(selection, value);
        }
        showToast(`已给 ${selection.length} 张加标签「${value}」`);
      } else if (isFixture) {
        setFixtureAlbums((previous) => ({
          ...previous,
          [value]: Array.from(new Set([...(previous[value] ?? []), ...selection])),
        }));
        showToast(`已把 ${selection.length} 张加入相册「${value}」`);
      } else {
        await albumAdd(value, selection);
        showToast(`已把 ${selection.length} 张加入相册「${value}」`);
      }
      setSelection([]);
      refreshData();
    } catch (err) {
      showToast(`批量操作失败：${String(err)}`);
    } finally {
      setBulkBusy(false);
    }
  };

  const [exporting, setExporting] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const handleExport = useCallback(async () => {
    if (exporting) return;
    // 全库一键导出必须是明确行为：没有选中、也没有任何筛选时拒绝，避免误触。
    if (!selection.length && !active) {
      showToast("先选中照片或套用筛选条件，再导出");
      return;
    }
    const remembered = window.localStorage.getItem("sg-export-dir") ?? undefined;
    const target = await pickFolder({ title: "选择导出目录", defaultPath: remembered });
    if (!target) return;
    window.localStorage.setItem("sg-export-dir", target);
    setExporting(true);
    try {
      const result = await exportAssets({
        ids: selection.length ? selection : undefined,
        filter: {
          query: query || undefined,
          tag: tags[0],
          album: album ?? undefined,
          scene: scene || undefined,
          person: person || undefined,
          place: place || undefined,
          limit: 100000,
          offset: 0,
        },
        target,
      });
      const text = `导出完成：成功 ${result.copied} / 跳过 ${result.skipped} / 失败 ${result.failed}`;
      if (result.copied === 0 && result.skipped > 0) {
        showToast(`${text}（全部为已存在且一致的文件）`, {
          label: "在 Finder 中显示",
          run: () => void revealInFinder(result.manifest),
        });
      } else {
        showToast(text, {
          label: "在 Finder 中显示",
          run: () => void revealInFinder(result.manifest),
        });
      }
    } catch (err) {
      showToast(`导出失败：${String(err)}`);
    } finally {
      setExporting(false);
    }
  }, [exporting, selection, active, query, tagKey, tags, album, scene, person, place, showToast]);

  const confirmDelete = useCallback(async () => {
    if (deleting || !selection.length) return;
    setDeleting(true);
    try {
      const result = await deleteRecords(selection);
      setDeleteOpen(false);
      setSelection([]);
      refreshData();
      showToast(
        `已移除 ${result.removed.assets} 条记录（磁盘文件未动）`,
      );
    } catch (err) {
      showToast(`移除失败：${String(err)}`);
    } finally {
      setDeleting(false);
    }
  }, [deleting, selection, refreshData, showToast]);

  const [importPlan, setImportPlan] = useState<ImportPlan | null>(null);
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importAuthError, setImportAuthError] = useState(false);

  const runImportPlan = useCallback(async () => {
    setImportBusy(true);
    setImportProgress(null);
    setImportAuthError(false);
    try {
      const plan = await importXiaomi(true);
      setImportPlan(plan);
    } catch (err) {
      const message = extractMessage(err);
      setImportAuthError(message.includes("登录态"));
      setImportProgress({ message });
      setImportPlan({ listed: 0, new: 0, existing: 0, bytes: 0 });
    } finally {
      setImportBusy(false);
    }
  }, []);

  const runImportDownload = useCallback(async () => {
    setImportBusy(true);
    try {
      await importXiaomi(false);
      setImportProgress({ stage: "xiaomi-done", message: "下载完成，正在生成缩略图…" });
      // 复用现成的缩略图链路，不让用户再手动跑一次。
      await generateThumbs(false);
      setImportPlan(null);
      setImportProgress(null);
      refreshData();
      showToast("小米相册导入完成");
    } catch (err) {
      const message = extractMessage(err);
      setImportAuthError(message.includes("登录态"));
      setImportProgress({ message });
    } finally {
      setImportBusy(false);
    }
  }, [refreshData, showToast]);

  const handleEmptyChoice = async (label: string) => {
    if (label.includes("小米")) {
      setImportPlan({ listed: 0, new: 0, existing: 0, bytes: 0 });
      void runImportPlan();
      return;
    }
    if (!label.includes("扫描")) {
      showToast(`${label}将在后续版本接入`);
      return;
    }
    try {
      const folder = await pickFolder();
      if (!folder) return;
      showToast("正在导入，缩略图会随后自动生成…");
      const result = await importFolder(folder);
      if (result.ok) {
        showToast("导入完成，正在刷新…");
        window.location.reload();
      } else {
        showToast("导入失败，请查看设置页或日志");
      }
    } catch (err) {
      showToast(`导入失败：${String(err)}`);
    }
  };

  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    void listen<ImportProgress>("import-progress", (event) => {
      setImportProgress(event.payload);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  useEffect(() => () => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    if (searchTimer.current) window.clearTimeout(searchTimer.current);
  }, []);

  useEffect(() => {
    let alive = true;
    Promise.all([libraryStats(), getFacets()])
      .then(([nextStats, nextFacets]) => {
        if (!alive) return;
        setStats(nextStats);
        setFacets(nextFacets);
      })
      .catch((reason: unknown) => {
        if (alive) setError(reason instanceof Error ? reason.message : String(reason));
      });
    health()
      .then((value) => alive && setHealthInfo(value))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (view !== "library") return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSelection([]);
    setAnchorId(null);
    const scope = tags.length === 1 ? `tag:${tags[0]}` : album ? `album:${album}` : null;
    const filter = {
      query: query || undefined,
      tag: isFixture && fixtureUserTags[tags[0]] ? undefined : tags[0],
      album: album ?? undefined,
      scene: scene || undefined,
      person: person || undefined,
      place: place || undefined,
      limit: PAGE_SIZE,
      offset: 0,
    };
    // 计数与分页都交给服务端，前端不再在「最多 N 条」里二次过滤。
    countAssets(filter)
      .then((total) => {
        if (!cancelled) setTotalCount(total);
      })
      .catch(() => {
        if (!cancelled) setTotalCount(null);
      });
    queryAssets(filter)
      .then((list) => {
        if (cancelled) return;
        const hidden = scope && isFixture ? new Set(localRemoved[scope] ?? []) : null;
        let visible = hidden ? list.filter((item) => !hidden.has(item.id)) : list;
        if (isFixture && tags.length === 1 && fixtureUserTags[tags[0]]) {
          const members = new Set(fixtureUserTags[tags[0]]);
          visible = visible.filter((item) => members.has(item.id));
        }
        if (isFixture && album) {
          const members = new Set(fixtureAlbums[album] ?? []);
          visible = visible.filter((item) => members.has(item.id));
        }
        setAssets(visible);
        setHasMore(visible.length === PAGE_SIZE);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [view, query, tagKey, tags.length, scene, person, place, album, dataVersion, localRemoved, fixtureAlbums, fixtureUserTags]);

  const needsAll =
    view === "timeline" || view === "tags" || view === "people" || view === "places" || view === "organize";

  useEffect(() => {
    if (view === "organize" || recognitionOpen) void live.activate();
  }, [view, recognitionOpen, live.activate]);

  useEffect(() => {
    if (!isFixture || demoStarted.current) return;
    if (route.demo !== "running" && route.demo !== "done" && route.demo !== "background") return;
    demoStarted.current = true;
    const count = route.demoCount > 0
      ? route.demoCount
      : route.demo === "done"
        ? 16
        : route.demo === "background"
          ? 24
          : 18;
    const speed = route.demoSpeed > 0
      ? route.demoSpeed
      : route.demo === "done"
        ? 12
        : route.demo === "background"
          ? 2.5
          : 3.5;
    void live.start({ mode: "sim", count, concurrency: 4, speed });
  }, [route.demo, route.demoCount, route.demoSpeed, live.start]);

  useEffect(() => {
    if (!needsAll || allAssets !== null) return;
    let cancelled = false;
    setAllLoading(true);
    queryAssets({ limit: ALL_LIMIT })
      .then((list) => {
        if (!cancelled) setAllAssets(list);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!cancelled) setAllLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [needsAll, allAssets]);

  const filteredAssets = useMemo(() => {
    // 服务端已经按 query/tag/scene/person/place 过滤；前端只在浏览器 fixture 里补这一层。
    if (!isFixture) return assets;
    return assets.filter(
      (asset) => matchesFilters(asset, { tags: [], scene, person, place }) && matchesSearch(asset, query),
    );
  }, [assets, tags, scene, person, place, query]);

  const categoryAssets = useMemo(() => {
    if (!drilldown || !allAssets) return [];
    return allAssets.filter((asset) => {
      if (drilldown.kind === "tags") return asset.tags.includes(drilldown.name);
      if (drilldown.kind === "people") return peopleList(asset.people).includes(drilldown.name);
      if (drilldown.kind === "scenes") return asset.scene === drilldown.name;
      return splitList(asset.place).includes(drilldown.name);
    });
  }, [allAssets, drilldown]);

  const currentList = useMemo(() => {
    if (view === "library") return filteredAssets;
    if (view === "timeline") return allAssets ?? [];
    if (drilldown) return categoryAssets;
    return [];
  }, [view, filteredAssets, allAssets, drilldown, categoryAssets]);

  const detailAsset = useMemo(() => {
    if (!detailId) return null;
    return (
      currentList.find((asset) => asset.id === detailId) ??
      assets.find((asset) => asset.id === detailId) ??
      allAssets?.find((asset) => asset.id === detailId) ??
      null
    );
  }, [detailId, currentList, assets, allAssets]);

  const detailIndex = detailAsset ? currentList.findIndex((asset) => asset.id === detailAsset.id) : -1;
  const detailTotal = currentList.length || (detailAsset ? 1 : 0);

  const placeTotal = useMemo(
    () => (allAssets ? buildCategories(allAssets, "places").length : 0),
    [allAssets],
  );
  const closeDetail = useCallback(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setDetailId(null);
      return;
    }
    setDetailClosing(true);
    window.setTimeout(() => {
      setDetailClosing(false);
      setDetailId(null);
    }, 200);
  }, []);

  const closeRecognition = useCallback(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setRecognitionOpen(false);
      return;
    }
    setDialogClosing(true);
    window.setTimeout(() => {
      setDialogClosing(false);
      setRecognitionOpen(false);
    }, 180);
  }, []);

  const openDetail = useCallback((asset: Asset, rect?: DOMRect) => {
    if (rect) setDetailOrigin({ x: rect.left, y: rect.top, w: rect.width, h: rect.height });
    else setDetailOrigin(null);
    setDetailId(asset.id);
    setSelection([asset.id]);
    setAnchorId(asset.id);
  }, []);

  const handleSelect = useCallback(
    (asset: Asset, event: React.MouseEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      if (event.shiftKey && anchorId) {
        const from = currentList.findIndex((item) => item.id === anchorId);
        const to = currentList.findIndex((item) => item.id === asset.id);
        if (from >= 0 && to >= 0) {
          const [start, end] = from < to ? [from, to] : [to, from];
          setSelection(currentList.slice(start, end + 1).map((item) => item.id));
          return;
        }
      }
      if (meta) {
        setSelection((previous) =>
          previous.includes(asset.id)
            ? previous.filter((id) => id !== asset.id)
            : [...previous, asset.id],
        );
        setAnchorId(asset.id);
        return;
      }
      setSelection([asset.id]);
      setAnchorId(asset.id);
    },
    [anchorId, currentList],
  );

  const navigateDetail = useCallback(
    (delta: number) => {
      if (!detailAsset || !currentList.length) return;
      const index = currentList.findIndex((asset) => asset.id === detailAsset.id);
      const next = currentList[index + delta];
      if (!next) return;
      setDetailId(next.id);
      setSelection([next.id]);
      setAnchorId(next.id);
    },
    [currentList, detailAsset],
  );

  const applyTag = useCallback((tag: string) => {
    setView("library");
    setDrilldown(null);
    setTags((previous) => unique([...previous, tag]));
    setDetailId(null);
  }, []);

  const handleSearchChange = useCallback((value: string) => {
    setQueryInput(value);
    if (value.trim()) {
      setView("library");
      setDrilldown(null);
    }
    if (searchTimer.current) window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => {
      pendingSearch.current = { start: performance.now(), value: value.trim() };
      setQuery(value.trim());
    }, 200);
  }, []);

  const clearSearch = useCallback(() => {
    if (searchTimer.current) window.clearTimeout(searchTimer.current);
    pendingSearch.current = null;
    setQueryInput("");
    setQuery("");
    searchRef.current?.focus();
  }, []);

  const clearAll = useCallback(() => {
    if (searchTimer.current) window.clearTimeout(searchTimer.current);
    pendingSearch.current = null;
    setQueryInput("");
    setQuery("");
    setTags([]);
    setScene(null);
    setPerson(null);
    setPlace(null);
    setDrilldown(null);
  }, []);

  const viewAlbumTag = useCallback(
    (tag: string) => {
      clearAll();
      setTags([tag]);
      setView("library");
      showToast(`已按标签「${tag}」查看相册 · 未写入数据库`);
    },
    [clearAll, showToast],
  );

  const navigate = useCallback(
    (next: View) => {
      clearAll();
      setView(next);
    },
    [clearAll],
  );

  const loadMore = useCallback(() => {
    if (loadingMore || !hasMore || view !== "library") return;
    const last = assets[assets.length - 1];
    // 有 taken_at 就走 keyset 游标（深翻页不随页数变慢）；缺失时退回 offset。
    const cursor = last?.taken_at ? [last.taken_at, last.id].join("|") : undefined;
    setLoadingMore(true);
    queryAssets({
      query: query || undefined,
      tag: isFixture && fixtureUserTags[tags[0]] ? undefined : tags[0],
      album: album ?? undefined,
      scene: scene || undefined,
      person: person || undefined,
      place: place || undefined,
      limit: PAGE_SIZE,
      cursor,
      offset: cursor ? 0 : assets.length,
    })
      .then((list) => {
        setAssets((previous) => [...previous, ...list]);
        setHasMore(list.length === PAGE_SIZE);
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setLoadingMore(false));
  }, [loadingMore, hasMore, view, query, tagKey, tags, album, scene, person, place, assets, fixtureUserTags]);

  useEffect(() => {
    if (view !== "library" || loading || firstGridMarked.current) return;
    if (assets.length === 0 && stats === null) return;
    firstGridMarked.current = true;
    requestAnimationFrame(() => {
      const elapsed = performance.now() - APP_START;
      document.documentElement.dataset.firstGridMs = elapsed.toFixed(1);
      console.log(`[perf] first-grid ${elapsed.toFixed(1)}ms · ${filteredAssets.length} 张`);
    });
  }, [view, loading, assets.length, stats, filteredAssets.length]);

  useEffect(() => {
    const pending = pendingSearch.current;
    if (!pending || loading || pending.value !== query) return;
    const frame = requestAnimationFrame(() => {
      const elapsed = performance.now() - pending.start;
      document.documentElement.dataset.searchMs = elapsed.toFixed(1);
      console.log(`[perf] search-render ${elapsed.toFixed(1)}ms · “${pending.value}” · ${filteredAssets.length} 条`);
      pendingSearch.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [loading, query, filteredAssets.length, assets]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";
      const meta = event.metaKey || event.ctrlKey;

      if (recognitionOpen) {
        if (event.key === "Escape") {
          event.preventDefault();
          setRecognitionOpen(false);
        }
        return;
      }

      if (meta && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (meta && event.key === "1") {
        event.preventDefault();
        navigate("library");
        return;
      }
      if (meta && event.key === "2") {
        event.preventDefault();
        navigate("timeline");
        return;
      }
      if (meta && event.key === "3") {
        event.preventDefault();
        setView("library");
        searchRef.current?.focus();
        return;
      }
      if (meta && (event.key === "+" || event.key === "=")) {
        event.preventDefault();
        setDensity("comfort");
        return;
      }
      if (meta && event.key === "-") {
        event.preventDefault();
        setDensity("compact");
        return;
      }
      if (meta && event.key === ",") {
        event.preventDefault();
        navigate("settings");
        return;
      }
      if (meta && event.key.toLowerCase() === "a" && !typing && view === "library") {
        event.preventDefault();
        setSelection(filteredAssets.map((asset) => asset.id));
        return;
      }

      if (detailAsset) {
        if (event.key === "Escape" || event.key === " ") {
          event.preventDefault();
          setDetailId(null);
        } else if (event.key === "ArrowLeft") {
          event.preventDefault();
          navigateDetail(-1);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          navigateDetail(1);
        }
        return;
      }

      if (view === "organize" || view === "settings") {
        if (event.key === "Escape") setRecognitionOpen(false);
        return;
      }

      if (typing) {
        if (event.key === "Escape") {
          if (queryInput) clearSearch();
          target?.blur();
        }
        return;
      }

      if (event.key === "Escape") {
        if (active) clearAll();
        else setSelection([]);
        return;
      }

      if (view !== "library" || filteredAssets.length === 0) return;
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter"].includes(event.key)) return;
      event.preventDefault();

      if (event.key === "Enter") {
        const asset = filteredAssets.find((item) => item.id === anchorId) ?? filteredAssets[0];
        openDetail(asset);
        return;
      }

      const currentIndex = Math.max(0, filteredAssets.findIndex((asset) => asset.id === anchorId));
      let nextIndex = currentIndex;
      if (event.key === "ArrowLeft") nextIndex = Math.max(0, currentIndex - 1);
      if (event.key === "ArrowRight") nextIndex = Math.min(filteredAssets.length - 1, currentIndex + 1);
      if (event.key === "ArrowUp") nextIndex = Math.max(0, currentIndex - columns);
      if (event.key === "ArrowDown") nextIndex = Math.min(filteredAssets.length - 1, currentIndex + columns);
      const nextAsset = filteredAssets[nextIndex];
      if (!nextAsset) return;
      if (event.shiftKey) {
        const from = Math.min(currentIndex, nextIndex);
        const to = Math.max(currentIndex, nextIndex);
        setSelection(filteredAssets.slice(from, to + 1).map((asset) => asset.id));
      } else {
        setSelection([nextAsset.id]);
      }
      setAnchorId(nextAsset.id);
      requestAnimationFrame(() => {
        document
          .querySelector(`[data-asset-id="${nextAsset.id}"]`)
          ?.scrollIntoView({ block: "nearest", inline: "nearest" });
      });
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    detailAsset,
    navigateDetail,
    queryInput,
    clearSearch,
    active,
    clearAll,
    view,
    filteredAssets,
    anchorId,
    columns,
    openDetail,
    navigate,
    recognitionOpen,
  ]);

  const range = yearRange(stats);
  const categoryCount = drilldown ? categoryAssets.length : (allAssets?.length ?? stats?.assets ?? 0);
  const title = (() => {
    if (view === "organize") return "整理视图";
    if (view === "settings") return "设置";
    if (album) return `相册 · ${album}`;
    if (query) return `搜索 “${query}”`;
    if (drilldown) return `${CATEGORY_LABEL[drilldown.kind]} · ${drilldown.name}`;
    if (view === "timeline") return "时间线";
    if (view === "tags") return "标签";
    if (view === "people") return "人物";
    if (view === "places") return "地点";
    if (person) return `人物 · ${person}`;
    if (place) return `地点 · ${place}`;
    if (scene) return `场景 · ${scene}`;
    if (tags.length === 1) return `标签 · ${tags[0]}`;
    if (tags.length > 1) return `标签 · ${tags[0]} 等 ${tags.length} 个`;
    return "全部照片";
  })();

  const count = view === "library" ? (active ? (totalCount ?? filteredAssets.length) : (stats?.assets ?? assets.length)) : categoryCount;
  const subtitle = [
    view === "organize"
      ? "AI 归位过程 · 只在内存预演"
      : view === "settings"
        ? "本地库 · 模型 · 缓存"
        : `${count} 张`,
    range || null,
    active && view === "library" ? "结果" : null,
  ]
    .filter(Boolean)
    .filter((value, index, list) => list.indexOf(value) === index)
    .join(" · ");

  const conditions: { key: string; label: string; remove: () => void }[] = [];
  if (query) conditions.push({ key: "query", label: `搜索 “${query}”`, remove: clearSearch });
  for (const tag of tags) {
    conditions.push({
      key: `tag-${tag}`,
      label: `标签 · ${tag}`,
      remove: () => setTags((previous) => previous.filter((item) => item !== tag)),
    });
  }
  if (scene) conditions.push({ key: "scene", label: `场景 · ${scene}`, remove: () => setScene(null) });
  if (person) conditions.push({ key: "person", label: `人物 · ${person}`, remove: () => setPerson(null) });
  if (place) conditions.push({ key: "place", label: `地点 · ${place}`, remove: () => setPlace(null) });
  if (drilldown) {
    conditions.push({
      key: "drilldown",
      label: `${CATEGORY_LABEL[drilldown.kind]} · ${drilldown.name}`,
      remove: () => setDrilldown(null),
    });
  }

  const content = (() => {
    if (error && view !== "organize" && view !== "settings") {
      return (
        <div className="error-state">
          <AlertCircle size={22} strokeWidth={1.7} />
          <h2>读取本地库失败</h2>
          <p>{error}</p>
        </div>
      );
    }

    if (view === "organize") {
      return (
        <OrganizeView
          live={live}
          assets={allAssets ?? []}
          demo={{
            autostart: route.demo === "running" || route.demo === "done",
            speed: route.demoSpeed,
            count: route.demoCount,
          }}
          onViewAlbum={viewAlbumTag}
          onOpenRecognition={() => setRecognitionOpen(true)}
          onToast={showToast}
        />
      );
    }

    if (view === "settings") {
      return <SettingsView onToast={showToast} />;
    }

    if (view === "tags" || view === "people" || view === "places") {
      if (!drilldown) {
        return (
          <Categories
            kind={view}
            assets={allAssets ?? []}
            loading={allLoading || allAssets === null}
            onPick={(kind, name) => setDrilldown({ kind, name })}
          />
        );
      }
      if (allLoading || allAssets === null) return <LoadingState label="正在读取分类照片…" />;
      if (categoryAssets.length === 0) {
        return <EmptyState mode="search" onChoose={handleEmptyChoice} onReset={() => setDrilldown(null)} />;
      }
      return (
        <VirtualGrid
          key={`${view}-${drilldown.kind}-${drilldown.name}`}
          assets={categoryAssets}
          columns={columns}
          selection={new Set(selection)}
          multi={selection.length > 1}
          onSelect={handleSelect}
          onOpen={openDetail}
        />
      );
    }

    if (view === "timeline") {
      if (allLoading || allAssets === null) return <LoadingState label="正在整理时间线…" />;
      if (allAssets.length === 0) return <EmptyState onChoose={handleEmptyChoice} />;
      return (
        <Timeline
          assets={allAssets}
          compact={density === "compact"}
          selection={new Set(selection)}
          multi={selection.length > 1}
          onSelect={handleSelect}
          onOpen={openDetail}
        />
      );
    }

    if (loading && assets.length === 0) return <LoadingState label="正在读取本地相册…" />;
    if (!loading && (stats?.assets === 0 || (assets.length === 0 && !active))) return <EmptyState onChoose={handleEmptyChoice} />;
    if (!loading && active && filteredAssets.length === 0) {
      return <EmptyState mode="search" onChoose={handleEmptyChoice} onReset={clearAll} />;
    }
    return (
      <div className="grid-wrap">
        {loading && <div className="content-loading-bar" />}
        <VirtualGrid
          key={`library-${query}-${tagKey}-${scene}-${person}-${place}`}
          assets={filteredAssets}
          columns={columns}
          selection={new Set(selection)}
          multi={selection.length > 1}
          onSelect={handleSelect}
          onOpen={openDetail}
          onLoadMore={loadMore}
          hasMore={hasMore}
          loadingMore={loadingMore}
        />
      </div>
    );
  })();

  return (
    <div className="app">
      <Sidebar
        stats={stats}
        facets={displayFacets}
        healthInfo={healthInfo}
        view={view}
        activeTags={tags}
        activeAlbum={album}
        activePerson={person}
        activePlace={place}
        placeTotal={placeTotal}
        onNavigate={navigate}
        onTag={applyTag}
        onAlbum={(name) => {
          setView("library");
          setDrilldown(null);
          setAlbum((current) => (current === name ? null : name));
        }}
        onPerson={(name) => {
          setView("library");
          setDrilldown(null);
          setPerson(name);
          setDetailId(null);
        }}
        onPlace={(name) => {
          setView("library");
          setDrilldown(null);
          setPlace(name);
          setDetailId(null);
        }}
        onSearch={() => searchRef.current?.focus()}
        liveStatus={{
          status: live.view.status,
          done: Math.min(live.view.total, live.view.done),
          total: Math.max(0, live.view.total),
          rate: live.view.rate,
          paused: live.view.paused,
        }}
        onRecognition={(rect?: DOMRect) => {
          if (rect) {
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;
            setDialogOrigin(`${x}px ${y}px`);
          }
          setRecognitionOpen(true);
        }}
        onSettings={() => navigate("settings")}
      />

      <main className="main">
        <Topbar
          title={title}
          subtitle={subtitle}
          onExport={selection.length > 0 || active ? () => void handleExport() : undefined}
          searchValue={queryInput}
          onSearchChange={handleSearchChange}
          onSearchClear={clearSearch}
          searchRef={searchRef}
          density={density}
          onDensity={setDensity}
          view={view}
          onView={navigate}
          minimal={view === "organize" || view === "settings"}
          theme={theme}
          onTheme={setTheme}
        />

        {conditions.length > 0 && view !== "organize" && view !== "settings" && (
          <div className="condition-bar">
            <div className="result-count">
              <Search size={12} strokeWidth={1.8} />
              <span>{count}{active && assets.length >= 1000 && view === "library" ? "+" : ""} 张结果</span>
            </div>
            <div className="chip-row">
              {conditions.map((condition) => (
                <span className="chip" key={condition.key}>
                  {condition.label}
                  <button type="button" onClick={condition.remove} aria-label={`移除 ${condition.label}`}>
                    <X size={11} strokeWidth={2} />
                  </button>
                </span>
              ))}
              {conditions.length > 1 && (
                <button type="button" className="clear-all" onClick={clearAll}>清除全部</button>
              )}
            </div>
            <div className="sort-note">按拍摄时间 · 最新优先</div>
          </div>
        )}

        <section className={clsx("content", view === "timeline" && "timeline-content")}>
          <div className="view-shell" key={view}>{content}</div>
        </section>
      </main>

      {detailAsset && (
        <Detail
          asset={detailAsset}
          index={Math.max(0, detailIndex)}
          total={view === "library" ? Math.max(detailTotal, stats?.assets ?? 0) : detailTotal}
          origin={detailOrigin}
          onClose={closeDetail}
          closing={detailClosing}
          onPrev={() => navigateDetail(-1)}
          onNext={() => navigateDetail(1)}
          onTag={applyTag}
          onAction={(label) => showToast(`${label}将在 P2 接入`)}
        />
      )}

      <RecognitionDialog
        open={recognitionOpen}
        live={live}
        origin={dialogOrigin}
        assets={new Map((allAssets ?? assets).map((asset) => [asset.id, asset]))}
        onClose={closeRecognition}
        closing={dialogClosing}
      />

      {selection.length > 0 && (
        <SelectionBar
          count={selection.length}
          busy={bulkBusy}
          tagContext={tags.length === 1 && userTagNames.has(tags[0]) ? tags[0] : null}
          albumContext={album}
          onTag={(tag) => void runBulk("tag", tag)}
          onAlbum={(name) => void runBulk("album", name)}
          onRemoveTag={(tag) => void runRemove("tag", tag)}
          onRemoveAlbum={(name) => void runRemove("album", name)}
          onDelete={() => setDeleteOpen(true)}
          onClear={() => setSelection([])}
        />
      )}

      {deleteOpen && (
        <DeleteDialog
          count={selection.length}
          busy={deleting}
          onCancel={() => setDeleteOpen(false)}
          onConfirm={() => void confirmDelete()}
        />
      )}

      {importPlan && (
        <ImportDialog
          plan={importProgress ? null : importPlan}
          progress={importProgress}
          busy={importBusy}
          authError={importAuthError}
          onCancel={() => {
            setImportPlan(null);
            setImportProgress(null);
            setImportAuthError(false);
          }}
          onConfirm={() => void runImportDownload()}
          onRetryAuth={() => void runImportPlan()}
        />
      )}

      {toast && (
        <div className="toast glass-surface" role="status">
          <span>{toast.text}</span>
          {toast.action && (
            <button
              type="button"
              className="toast-action"
              onClick={() => {
                const action = toast.action;
                setToast(null);
                action?.run();
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function LoadingState({ label }: { label: string }) {
  return (
    <div className="loading-state">
      <LoaderCircle size={20} strokeWidth={1.6} className="spin" />
      <span>{label}</span>
    </div>
  );
}
