import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { listen } from "@tauri-apps/api/event";
import {
  AlertCircle,
  Clock,
  Folder,
  HardDrive,
  Images,
  LoaderCircle,
  MapPin,
  Search,
  Settings,
  Sparkles,
  Tags,
  Users,
  X,
} from "lucide-react";
import {
  getFacets,
  health,
  isFixture,
  libraryStats,
  queryAssets,
  countAssets,
  timelineMonths,
  albumGroups,
  categoryGroups,
  dupGroups,
  type MonthSummary,
  type AlbumSummary,
  type GroupSummary,
  type Asset,
  type Facets,
  type SortKey,
  type Health,
  type Stats,
  pickFolder,
  importFolder,
  importSummary,
  type ImportSummary,
  isTauri,
  importXiaomi,
  cleanupList,
  type CleanupEntry,
  generateThumbs,
  bulkTag,
  exportAssets,
  deleteRecords,
  describeDeleteError,
  libraryAccess,
  openPrivacySettings,
  revealInFinder,
  albumAdd,
} from "./api";
import { Sidebar } from "./components/Sidebar";
import { Topbar } from "./components/Topbar";
import { VirtualGrid } from "./components/VirtualGrid";
import { Timeline } from "./components/Timeline";
import { Albums } from "./components/Albums";
import { Categories } from "./components/Categories";
import { CommandPalette, type PaletteItem, type PaletteSection } from "./components/CommandPalette";
import { Detail } from "./components/Detail";
import { SelectionBar } from "./components/SelectionBar";
import { ImportDialog, type ImportPlan, type ImportProgress } from "./components/ImportDialog";
import { DeleteDialog } from "./components/DeleteDialog";
import { AccessDialog } from "./components/AccessDialog";
import { EmptyState } from "./components/EmptyState";
import { ImportProgressView, ImportMiniBar, type FolderProgress } from "./components/ImportProgress";
import { ImportSummaryView } from "./components/ImportSummary";
import { OrganizeView } from "./components/OrganizeView";
import { RecognitionDialog } from "./components/RecognitionDialog";
import { SettingsView } from "./components/SettingsView";
import { SpaceView, assetFromEntry } from "./components/SpaceView";
import { AlbumPicker } from "./components/AlbumPicker";
import { TagPicker } from "./components/TagPicker";
import { openTrash, openExternal } from "./api";
import { liveEventMessage, useLiveController } from "./live";
import {
  gridColumnCount,
  matchesFilters,
  matchesSearch,
  unique,
  yearRange,
  type CategoryKind,
  type View,
} from "./utils";

type Density = "comfort" | "compact";

type DupInfo = { groupId: number; keeperId: string; count: number };

const EXPORT_LIMIT = 100000;
const PAGE_SIZE = 200;

/** 排序项：按钮上显示短标签，菜单里显示完整说法 */
const SORT_LABELS: Record<SortKey, string> = {
  taken_desc: "按拍摄时间 · 最新优先",
  taken_asc: "按拍摄时间 · 最早优先",
  size_desc: "按文件大小 · 从大到小",
  size_asc: "按文件大小 · 从小到大",
};
const APP_START = performance.now();

function readRoute() {
  const params = new URLSearchParams(window.location.search);
  const requestedView = params.get("view");
  const view: View =
    requestedView === "timeline" ||
    requestedView === "tags" ||
    requestedView === "people" ||
    requestedView === "places" ||
    requestedView === "space" ||
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
  // Status：成功，3 秒；Action：可撤销，5 秒 + 环形倒计时；
  // Sticky：失败/需要处理，永不自动消失；Progress：进度，完成后原地变结果。
  type ToastKind = "status" | "action" | "sticky" | "progress";
  type ToastState = {
    text: string;
    kind: ToastKind;
    action?: ToastAction;
    /** 环形倒计时的总时长（ms），只对 action 有效。 */
    duration?: number;
    shownAt?: number;
    /** progress 完成后替换成的结果文案与按钮。 */
    result?: { text: string; action?: ToastAction };
  };

const route = useMemo(readRoute, []);
  const [view, setView] = useState<View>(route.query ? "library" : route.view);
  const [stats, setStats] = useState<Stats | null>(null);
  const [facets, setFacets] = useState<Facets | null>(null);
  const [healthInfo, setHealthInfo] = useState<Health | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  // 去重索引：asset_id -> 所在组。只影响网格怎么显示，不改分页/游标。
  const [dupIndex, setDupIndex] = useState<Map<string, DupInfo>>(new Map());
  // 只给整理视图用，上限 500，不再把整库读进内存
  const [allAssets, setAllAssets] = useState<Asset[] | null>(null);
  const [months, setMonths] = useState<MonthSummary[] | null>(null);
  const [albums, setAlbums] = useState<AlbumSummary[] | null>(null);
  // 按 kind 缓存，避免在标签/全部照片之间来回切时反复重算聚合（一次扫描 100k 约 370ms）
  const [groupsByKind, setGroupsByKind] = useState<Record<string, GroupSummary[]>>({});
  const [catKind, setCatKind] = useState<CategoryKind>("tags");
  const [dayFrom, setDayFrom] = useState<string | null>(null);
  const [dayTo, setDayTo] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
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
  const [sort, setSort] = useState<SortKey>(() => {
    const value = new URLSearchParams(window.location.search).get("sort");
    return value === "taken_asc" || value === "size_desc" || value === "size_asc" ? value : "taken_desc";
  });
  const [selection, setSelection] = useState<string[]>(route.assetId ? [route.assetId] : []);
  /** 选择模式：单击即选中，不弹详情；由右上角的「多选」开关切换 */
  const [selectMode, setSelectMode] = useState(false);
  const [anchorId, setAnchorId] = useState<string | null>(route.assetId);
  const [detailId, setDetailId] = useState<string | null>(route.assetId);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [dialogRect, setDialogRect] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [album, setAlbum] = useState<string | null>(null);
  const [detailClosing, setDetailClosing] = useState(false);
  // 空间页的清理删的是待清理清单，不是网格里的选择；单独存一份，确认卡复用 DeleteDialog。
  const [spaceClean, setSpaceClean] = useState<{ ids: string[]; bytes: number } | null>(null);
  const [spaceQueueSignal, setSpaceQueueSignal] = useState(0);
  // 详情页单张删除：独立的确认卡与错误，不和网格选择混在一起。
  const [detailDelete, setDetailDelete] = useState<{ id: string; origin: DOMRect | null } | null>(null);
  const [detailDeleteError, setDetailDeleteError] = useState<string | null>(null);
  // 详情页「加入相册」选择器；导出这一张时禁一下重复点击。
  const [albumPick, setAlbumPick] = useState<{ ids: string[] } | null>(null);
  const [tagPick, setTagPick] = useState(false);
  const [detailExporting, setDetailExporting] = useState(false);
  // 详情页单张识别进行中：按钮禁用，事件回来时刷新这一张。
  const [recognizing, setRecognizing] = useState(false);
  const [dialogClosing, setDialogClosing] = useState(false);
  const [detailOrigin, setDetailOrigin] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [detailStep, setDetailStep] = useState(0);
  const [selectionOrigin, setSelectionOrigin] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  // 分类卡/月份行进入图库时，把那张封面带过来（落地后淡出，静止状态不变）
  const [flyCover, setFlyCover] = useState<{ src: string; rect: DOMRect; key: number } | null>(null);
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
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteOrigin, setPaletteOrigin] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const live = useLiveController();
  const demoStarted = useRef(false);

  const detailCloseTimer = useRef<number | null>(null);
  const dialogCloseTimer = useRef<number | null>(null);
  const pendingDetailStep = useRef(0);
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
  const active = Boolean(query || tags.length || scene || person || place || album || dayFrom || dayTo);
  const columns = gridColumnCount(viewportWidth, density);

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  /** 成功/可撤销：自动消失；失败/需要处理：常驻，等用户关。 */
  const showToast = useCallback((message: string, options?: ToastAction | { kind?: ToastKind; action?: ToastAction }) => {
    const opts = options && ("run" in options ? { action: options as ToastAction } : options);
    const kind: ToastKind = opts?.kind ?? (opts?.action ? "action" : "status");
    const duration = kind === "action" ? 5000 : kind === "status" ? 3000 : undefined;
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    setToast({ text: message, kind, action: opts?.action, duration, shownAt: Date.now() });
    if (duration) {
      toastTimer.current = window.setTimeout(() => setToast(null), duration);
    }
  }, []);

  /** 失败提示：不自动消失，用户手动关。 */
  const showError = useCallback((message: string) => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    setToast({ text: message, kind: "sticky", shownAt: Date.now() });
  }, []);

  /** 进度：先显示进度，结束后在同一位置变成结果。 */
  const showProgress = useCallback((message: string) => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    setToast({ text: message, kind: "progress", shownAt: Date.now() });
  }, []);

  const settleProgress = useCallback((result: { text: string; action?: ToastAction }) => {
    setToast((previous) =>
      previous?.kind === "progress"
        ? { ...previous, kind: result.action ? "action" : "status", text: result.text, result: undefined, action: result.action, duration: result.action ? 5000 : 3000, shownAt: Date.now() }
        : previous,
    );
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), result.action ? 5000 : 3000);
  }, []);

  const refreshData = useCallback(() => {
    getFacets().then(setFacets).catch(() => undefined);
    // 统计也要刷：删掉记录后侧栏「全部照片」不能还显示旧数字。
    libraryStats().then(setStats).catch(() => undefined);
    setDataVersion((version) => version + 1);
  }, []);

  /** 识别/编辑后只刷新详情里这一张，避免整页重排。 */
  const refreshAsset = useCallback(async (id: string) => {
    // 详情里重识别后拿回完整的一行（包括新的 caption/tags），不然面板还是旧描述。
    try {
      const [fresh] = await queryAssets({ limit: 1, offset: 0, query: id });
      if (fresh) {
        setAssets((previous) => previous.map((asset) => (asset.id === id ? fresh : asset)));
        setSpacePreviewAsset((previous) => (previous?.id === id ? fresh : previous));
        setSpacePreviewList((previous) => previous.map((asset) => (asset.id === id ? fresh : asset)));
      }
    } catch {
      // 刷新失败不影响识别本身
    }
    refreshData();
  }, [refreshData]);

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
          kind: "action",
          action: {
            label: "撤销",
            run: () => {
              const undo = pendingUndo.current;
              pendingUndo.current = null;
              if (!undo) return;
              void undo.revert().then(
                () => showToast("已撤销"),
                (err: unknown) => showError(`撤销失败：${String(err)}`),
              );
            },
          },
        });
      } catch (err) {
        showError(`移除失败：${String(err)}`);
      } finally {
        setBulkBusy(false);
      }
    },
    [selection, bulkBusy, refreshData, setLocalRemoval, showToast],
  );

  /** 批量加标签：面板里点已有标签或回车建新标签都走这里，成功才关面板。 */
  const runBulkTag = useCallback(
    async (tag: string) => {
      if (!selection.length || bulkBusy) return;
      const ids = [...selection];
      setBulkBusy(true);
      try {
        if (isFixture) {
          setFixtureUserTags((previous) => ({
            ...previous,
            [tag]: Array.from(new Set([...(previous[tag] ?? []), ...ids])),
          }));
        } else {
          await bulkTag(ids, tag);
        }
        showToast(`已给 ${ids.length} 张加标签「${tag}」`);
        setTagPick(false);
        setSelection([]);
        refreshData();
      } catch (err) {
        showError(`加标签失败：${String(err)}`);
        throw err;
      } finally {
        setBulkBusy(false);
      }
    },
    [bulkBusy, refreshData, selection, setFixtureUserTags, showError, showToast],
  );

  /** 批量加入相册：AlbumPicker 一次把选中的 id 全传进去。 */
  const runBulkAlbum = useCallback(
    async (ids: string[], name: string) => {
      if (!ids.length) return;
      setBulkBusy(true);
      try {
        if (isFixture) {
          setFixtureAlbums((previous) => ({
            ...previous,
            [name]: Array.from(new Set([...(previous[name] ?? []), ...ids])),
          }));
          showToast(`已把 ${ids.length} 张加入相册「${name}」`);
        } else {
          const result = await albumAdd(name, ids);
          if (!result.ok) throw new Error("加入相册没有返回成功");
          showToast(`已把 ${ids.length} 张加入相册「${name}」`);
        }
        setAlbumPick(null);
        setSelection([]);
        refreshData();
      } catch (err) {
        showError(`批量操作失败：${String(err)}`);
      } finally {
        setBulkBusy(false);
      }
    },
    [refreshData, setFixtureAlbums, showError, showToast],
  );

  const [exporting, setExporting] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  /** 库里照片所在目录读不了（授权没给）：启动检查一次，给张卡让人去开权限 */
  const [blockedRoots, setBlockedRoots] = useState<string[] | null>(null);
  const [deleting, setDeleting] = useState(false);
  const handleExport = useCallback(async () => {
    if (exporting) return;
    // 全库一键导出必须是明确行为：没有选中、也没有任何筛选时拒绝，避免误触。
    if (!selection.length && !active) {
      showError("先选中照片或套用筛选条件，再导出");
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
          // 导出是一次性批量操作，不是列表渲染；这里保留全量，不走 queryAssets 的 2000 上限
          limit: EXPORT_LIMIT,
          offset: 0,
        },
        target,
      });
      const text = `导出完成：成功 ${result.copied} / 跳过 ${result.skipped} / 失败 ${result.failed}`;
      if (result.copied === 0 && result.skipped > 0) {
        showToast(`${text}（全部为已存在且一致的文件）`, {
          kind: "action",
          action: { label: "在 Finder 中显示", run: () => void revealInFinder(result.manifest) },
        });
      } else {
        showToast(text, {
          kind: "action",
          action: { label: "在 Finder 中显示", run: () => void revealInFinder(result.manifest) },
        });
      }
    } catch (err) {
      showError(`导出失败：${String(err)}`);
    } finally {
      setExporting(false);
    }
  }, [exporting, selection, active, query, tagKey, tags, album, scene, person, place, showToast]);

  const confirmDelete = useCallback(async () => {
    if (deleting || !selection.length) return;
    setDeleting(true);
    try {
      const result = await deleteRecords(selection, true);
      setDeleteOpen(false);
      setSelection([]);
      refreshData();
      const failed = result.files?.failed?.length ?? 0;
      showToast(
        failed
          ? `${failed} 个文件没能移到废纸篓，未删除任何记录`
          : `已删除 ${result.removed.assets} 张，原图在废纸篓`,
      );
    } catch (err) {
      showError(`移除失败：${describeDeleteError(err)}`);
    } finally {
      setDeleting(false);
    }
  }, [deleting, selection, refreshData, showToast]);

  const openSpaceClean = useCallback((ids: string[], rect: DOMRect) => {
    if (!ids.length) return;
    setDialogRect({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
    void cleanupList()
      .then((list) => {
        const wanted = new Set(ids);
        const bytes = list.items
          .filter((item) => wanted.has(item.asset_id))
          .reduce((sum, item) => sum + (item.size ?? 0), 0);
        setSpaceClean({ ids, bytes });
      })
      .catch(() => setSpaceClean({ ids, bytes: 0 }));
  }, []);

  const openSpacePreview = useCallback(
    (entry: CleanupEntry, list: Asset[] = []) => {
      const asset = list.find((item) => item.id === entry.asset_id) ?? assetFromEntry(entry);
      setDetailDeleteError(null);
      setSpacePreviewList(list);
      setSpacePreviewAsset(asset);
      setDetailOrigin(null);
      setDetailId(entry.asset_id);
    },
    [],
  );

  const confirmSpaceClean = useCallback(async () => {
    if (deleting || !spaceClean) return;
    setDeleting(true);
    try {
      const result = await deleteRecords(spaceClean.ids, true);
      setSpaceClean(null);
      refreshData();
      showToast("已清理 " + result.removed.assets + " 个，原图在废纸篓", { kind: "action", action: { label: "打开废纸篓", run: () => void openTrash() } });
    } catch (err) {
      showError("清理失败：" + describeDeleteError(err));
    } finally {
      setDeleting(false);
    }
  }, [deleting, spaceClean, refreshData, showToast]);



  const [importPlan, setImportPlan] = useState<ImportPlan | null>(null);
  // 空状态「扫描本地文件夹」：整页进度视图 + 可收起细条。
  const [folderImport, setFolderImport] = useState<FolderProgress | null>(null);
  const [folderImportOpen, setFolderImportOpen] = useState(false);
  const [folderImportBusy, setFolderImportBusy] = useState(false);
  const [folderImportError, setFolderImportError] = useState<string | null>(null);
  // 导入成功后的总结页：只在这一次导入后出现，关掉就清空（不持久化）。
  const [importSummaryView, setImportSummaryView] = useState<{
    data: ImportSummary;
    added: number;
    first: boolean;
  } | null>(null);
  const folderTarget = useRef<string | null>(null);
  // ingest 统计里的「新增」：事件一路更新，成功时从这里取，避免闭包读到旧值。
  const folderAdded = useRef(0);
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

  /** 真正开始一个文件夹导入：先切到进度视图，再等后端事件。 */
  const runFolderImport = useCallback(
    async (folder: string) => {
      folderTarget.current = folder;
      folderAdded.current = 0;
      setFolderImportError(null);
      setFolderImport({ stage: "ingest", seen: 0, added: 0, skipped: 0 });
      setFolderImportOpen(true);
      setFolderImportBusy(true);
      try {
        const result = await importFolder(folder);
        if (!result.ok) {
          const message = "导入没有返回成功";
          setFolderImportError(message);
          showError("导入失败：" + message);
          return;
        }
        const stats = (result.stats ?? {}) as { new?: number };
        const added = typeof stats.new === "number" ? stats.new : folderAdded.current;
        // 进度视图收掉，换成总结页；库数据先刷新，保证总结里的数字就是眼前的库。
        setFolderImport(null);
        setFolderImportOpen(false);
        refreshData();
        try {
          const data = await importSummary();
          // 空库第一次导入：库总数就等于这次的增量（只跟本次 ingest 比，不看账号历史）。
          setImportSummaryView({ data, added, first: added > 0 && data.total === added });
        } catch (summaryError) {
          // 汇总拉不到不该挡住宿主看照片：退回原来的成功提示。
          setImportSummaryView(null);
          showToast("导入完成");
          showError("读取导入汇总失败：" + extractMessage(summaryError));
        }
      } catch (err) {
        const message = extractMessage(err);
        setFolderImportError(message);
        showError("导入失败：" + message);
      } finally {
        setFolderImportBusy(false);
      }
    },
    [refreshData, showError, showToast],
  );

  const handleEmptyChoice = async (label: string) => {
    if (label.includes(String.fromCharCode(23567,31859)) || label.includes(String.fromCharCode(35782,21035))) {
      setRecognitionOpen(true);
      return;
    }
    if (!label.includes(String.fromCharCode(25195,25551))) return;
    const folder = await pickFolder();
    if (!folder) return;
    void runFolderImport(folder);
  };

  // 文件夹导入：ingest 阶段每 200 个文件一条；缩略图阶段沿用 thumbs-progress。
  useEffect(() => {
    let alive = true;
    const cleanups: Array<() => void> = [];
    const register = <T,>(name: string, handler: (payload: T) => void) => {
      if (!isTauri) {
        // 浏览器 fixture：允许 window.dispatchEvent(new CustomEvent(name, { detail }))
        const listener = (event: Event) => handler((event as CustomEvent<T>).detail);
        window.addEventListener(name, listener);
        cleanups.push(() => window.removeEventListener(name, listener));
        return;
      }
      void listen<T>(name, (event) => handler(event.payload)).then((fn) => {
        if (alive) cleanups.push(fn);
        else fn();
      });
    };

    register<Record<string, unknown>>("import-progress", (payload) => {
      const stage = String(payload.stage ?? "");
      if (stage === "failed") {
        const message = String(payload.message ?? "导入失败");
        setFolderImportError(message);
        setFolderImportBusy(false);
        setFolderImportOpen(true);
        showError("导入失败：" + message);
        return;
      }
      // done 也要接：否则最后一格进度停住、标题永远停在「正在生成缩略图」。
      if (stage !== "ingest" && stage !== "ingest-done" && stage !== "thumbs" && stage !== "done") return;
      if (typeof payload.new === "number") folderAdded.current = payload.new;
      setFolderImport((previous) => {
        const base: FolderProgress = previous ?? { stage: "ingest", seen: 0, added: 0, skipped: 0 };
        return {
          ...base,
          stage: stage as FolderProgress["stage"],
          seen: typeof payload.seen === "number" ? payload.seen : base.seen,
          added: typeof payload.new === "number" ? payload.new : base.added,
          skipped: typeof payload.skipped === "number" ? payload.skipped : base.skipped,
        };
      });
      // 兼容旧的云相册导入弹窗：它也用 import-progress，但带 message/done/total。
      if (stage === "thumbs" && (payload.message || payload.total)) {
        setImportProgress(payload as ImportProgress);
      }
    });

    register<{ done?: number; total?: number; rate_per_s?: number; eta_s?: number | null }>("thumbs-progress", (payload) => {
      setFolderImport((previous) =>
        previous
          ? {
              ...previous,
              // 最后一条 done==total 就是收尾，直接进「导入完成」，别再停在缩略图阶段。
              stage:
                payload.done != null && payload.total != null && payload.total > 0 && payload.done >= payload.total
                  ? "done"
                  : "thumbs",
              thumbs: {
                done: payload.done ?? 0,
                total: payload.total ?? 0,
                rate: payload.rate_per_s ?? 0,
                eta: payload.eta_s ?? null,
              },
            }
          : previous,
      );
    });

    register<ImportProgress>("import-xiaomi-progress", (payload) => setImportProgress(payload));

    return () => {
      alive = false;
      cleanups.forEach((fn) => fn());
    };
  }, [showError]);

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

  const checkAccess = useCallback(() => {
    void libraryAccess()
      .then((report) => {
        const blocked = report.roots.filter((root) => root.exists && !root.readable).map((root) => root.root);
        setBlockedRoots(blocked.length ? blocked : null);
      })
      .catch((reason: unknown) => {
        showError(`检查照片目录权限失败：${String(reason)}`);
      });
  }, [showToast]);

  useEffect(checkAccess, [checkAccess]);

  useEffect(() => {
    let alive = true;
    dupGroups()
      .then((groups) => {
        if (!alive) return;
        const index = new Map<string, DupInfo>();
        for (const group of groups) {
          for (const member of group.members) {
            index.set(member.asset_id, {
              groupId: group.id,
              keeperId: group.keeper_id,
              count: group.count,
            });
          }
        }
        setDupIndex(index);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [dataVersion]);

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
      day_from: dayFrom ?? undefined,
      day_to: dayTo ?? undefined,
      limit: PAGE_SIZE,
      offset: 0,
      sort,
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
  }, [view, query, tagKey, tags.length, scene, person, place, album, dayFrom, dayTo, sort, dataVersion, localRemoved, fixtureAlbums, fixtureUserTags]);

  const needsAll = view === "organize";

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
    queryAssets({ limit: 500 })
      .then((list) => {
        if (!cancelled) setAllAssets(list);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
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

  // 网格折叠重复项：保留 keeper；如果 keeper 被当前筛选排除，就让组里第一张可见的顶上，
  // 否则筛选结果会凭空少一截。折叠只发生在已加载的这一页，不动分页/游标。
  const displayAssets = useMemo(() => {
    if (dupIndex.size === 0) return filteredAssets;
    const visible = new Set(filteredAssets.map((asset) => asset.id));
    return filteredAssets.filter((asset) => {
      const dup = dupIndex.get(asset.id);
      if (!dup || dup.keeperId === asset.id) return true;
      return !visible.has(dup.keeperId);
    });
  }, [filteredAssets, dupIndex]);

  const dupCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const asset of displayAssets) {
      const dup = dupIndex.get(asset.id);
      if (dup) counts.set(asset.id, dup.count);
    }
    return counts;
  }, [displayAssets, dupIndex]);

  useEffect(() => {
    if (view !== "albums" || albums) return;
    let cancelled = false;
    albumGroups()
      .then((list) => { if (!cancelled) setAlbums(list); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [view, albums]);

  useEffect(() => {
    if (view !== "timeline" || months) return;
    let cancelled = false;
    timelineMonths()
      .then((list) => { if (!cancelled) setMonths(list); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [view, months]);

  useEffect(() => {
    if (view !== "tags" && view !== "people" && view !== "places") return;
    if (groupsByKind[catKind]) return;
    let cancelled = false;
    categoryGroups(catKind)
      .then((list) => { if (!cancelled) setGroupsByKind((prev) => ({ ...prev, [catKind]: list })); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [view, catKind, groupsByKind]);

  const groups = groupsByKind[catKind] ?? null;

  // 详情页「重新识别这一张」：记住触发时的 id，识别事件回来只刷新这一张。

  // 空间页的预览复用详情：已加载的按大小排序列表就是它的前后翻页范围。
  const [spacePreviewList, setSpacePreviewList] = useState<Asset[]>([]);
  const [spacePreviewAsset, setSpacePreviewAsset] = useState<Asset | null>(null);
  const currentList = useMemo(() => {
    if (view === "library") return displayAssets;
    if (view === "space") return spacePreviewList;
    return [];
  }, [view, displayAssets, spacePreviewList]);



  const detailAsset = useMemo(() => {
    if (!detailId) return null;
    return (
      currentList.find((asset) => asset.id === detailId) ??
      assets.find((asset) => asset.id === detailId) ??
      (spacePreviewAsset?.id === detailId ? spacePreviewAsset : null)
    );
  }, [detailId, currentList, assets, spacePreviewAsset]);

  const detailIndex = detailAsset ? currentList.findIndex((asset) => asset.id === detailAsset.id) : -1;
  const detailTotal = currentList.length || (detailAsset ? 1 : 0);
  // 从时间线点进某个月时，详情计数器要显示这个月的张数，不是整库
  const monthTotal = dayFrom ? months?.find((m) => m.month === dayFrom.slice(0, 7))?.count : undefined;

  const placeTotal = facets?.places?.length ?? 0;
  const closeDetail = useCallback(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setDetailId(null);
      return;
    }
    if (detailCloseTimer.current) window.clearTimeout(detailCloseTimer.current);
    setDetailClosing(true);
    detailCloseTimer.current = window.setTimeout(() => {
      detailCloseTimer.current = null;
      setDetailClosing(false);
      setDetailId(null);
    }, 300);
  }, []);

  /** 单张重新识别：真实识别（mode=live）只跑这一张并覆盖旧描述。 */
  const recognizeOne = useCallback(
    async (asset: Asset) => {
      if (recognizing) return;
      setDetailDeleteError(null);
      try {
        const ok = await live.start({
          mode: isFixture ? "sim" : "live",
          ids: [asset.id],
          force: true,
          count: 1,
          concurrency: 1,
        });
        if (!ok) {
          setDetailDeleteError(live.error ?? "识别服务没有启动，请稍后重试");
          return;
        }
        setRecognizing(true);
        showToast(isFixture ? "预览模式：逐张识别只跑模拟" : "正在重新识别这一张…");
      } catch (err) {
        setDetailDeleteError(`重新识别失败：${extractMessage(err)}`);
      }
    },
    [isFixture, live, recognizing, showToast],
  );

  const askDeleteDetail = useCallback((rect?: DOMRect | null) => {
    if (!detailAsset || deleting) return;
    setDetailDeleteError(null);
    setDetailDelete({ id: detailAsset.id, origin: rect ?? null });
  }, [deleting, detailAsset]);

  const confirmDetailDelete = useCallback(async () => {
    if (!detailDelete || deleting) return;
    setDeleting(true);
    try {
      const result = await deleteRecords([detailDelete.id], true);
      setDetailDelete(null);
      setDetailDeleteError(null);
      closeDetail();
      refreshData();
      showToast(`已删除 ${result.removed.assets} 张，原图在废纸篓`);
    } catch (err) {
      const message = describeDeleteError(err);
      setDetailDeleteError(message);
      showError("删除失败：" + message);
      setDetailDelete(null);
    } finally {
      setDeleting(false);
    }
  }, [closeDetail, deleteRecords, deleting, detailDelete, refreshData, showToast]);

  const exportOne = useCallback(async (asset: Asset) => {
    if (detailExporting) return;
    const remembered = window.localStorage.getItem("sg-export-dir") ?? undefined;
    const target = await pickFolder({ title: "选择导出目录", defaultPath: remembered });
    if (!target) return;
    window.localStorage.setItem("sg-export-dir", target);
    setDetailExporting(true);
    try {
      const result = await exportAssets({ ids: [asset.id], target });
      showToast(
        result.copied ? `已导出这一张（${result.copied} 个文件）` : "目标目录里已有同名且一致的文件",
        { label: "在 Finder 中显示", run: () => void revealInFinder(result.manifest) },
      );
    } catch (err) {
      showError(`导出失败：${extractMessage(err)}`);
    } finally {
      setDetailExporting(false);
    }
  }, [detailExporting, showToast]);

  // 识别事件回来：失败就在详情里说明，成功则只刷新当前这一张，并关掉「识别中」。
  useEffect(() => {
    if (!recognizing || !detailId) return;
    const failure = liveEventMessage(live.events);
    const finished = live.events.some(
      (event) => event.type === "done" && event.asset_id === detailId,
    );
    const stopped = live.events.some((event) => event.type === "session_done" || event.type === "session_stopped");
    if (failure) {
      setDetailDeleteError(`重新识别失败：${failure}`);
      showError(`重新识别失败：${failure}`);
      setRecognizing(false);
      return;
    }
    if (finished || (stopped && !live.view.active)) {
      setRecognizing(false);
      void refreshAsset(detailId);
      showToast("已重新识别这一张");
    }
  }, [detailId, live.events, live.view.active, recognizing, refreshAsset, showToast]);

  const closeRecognition = useCallback(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setRecognitionOpen(false);
      return;
    }
    if (dialogCloseTimer.current) window.clearTimeout(dialogCloseTimer.current);
    setDialogClosing(true);
    dialogCloseTimer.current = window.setTimeout(() => {
      dialogCloseTimer.current = null;
      setDialogClosing(false);
      setRecognitionOpen(false);
    }, 180);
  }, []);

  const openDetail = useCallback((asset: Asset, rect?: DOMRect) => {
    // 上一个关闭动画还在跑时又打开了新的，不能让它把新的那张关掉
    if (detailCloseTimer.current) {
      window.clearTimeout(detailCloseTimer.current);
      detailCloseTimer.current = null;
      setDetailClosing(false);
    }
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
      if (meta || selectMode) {
        const rect = event.currentTarget.getBoundingClientRect();
        if (selection.length === 0) {
          setSelectionOrigin({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
        }
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
    [anchorId, currentList, selection.length, selectMode],
  );

  const applyTag = useCallback((tag: string) => {
    setView("library");
    setTags((previous) => unique([...previous, tag]));
    setDetailId(null);
  }, []);

  // 侧栏的标签是“按一下筛、再按一下取消”，和相册保持一致。
  const toggleTag = useCallback((tag: string) => {
    setView("library");
    setDetailId(null);
    setTags((previous) =>
      previous.includes(tag) ? previous.filter((item) => item !== tag) : unique([...previous, tag]),
    );
  }, []);

  const handleSearchChange = useCallback((value: string) => {
    setQueryInput(value);
    if (value.trim()) {
      setView("library");
    }
    if (searchTimer.current) window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => {
      pendingSearch.current = { start: performance.now(), value: value.trim() };
      setQuery(value.trim());
    }, 200);
  }, []);

  // 面板从触发它的搜索框长出来，所以要记住那个框的矩形。
  const openPalette = useCallback((from?: DOMRect) => {
    // 从哪个控件打开就从哪里长出来；键盘 ⌘K 默认用顶栏搜索框。
    const box = from ?? document.querySelector<HTMLElement>(".search")?.getBoundingClientRect();
    if (box) {
      setPaletteOrigin({ x: box.left, y: box.top, width: box.width, height: box.height });
    }
    setPaletteOpen(true);
  }, []);

  const clearSearch = useCallback(() => {
    if (searchTimer.current) window.clearTimeout(searchTimer.current);
    pendingSearch.current = null;
    setQueryInput("");
    setQuery("");
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
    setDayFrom(null);
    setDayTo(null);
    // 相册也是筛选条件之一：漏掉它，「清除全部」之后结果会少一截。
    setAlbum(null);
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
      // 总结页只在刚导入完那一下出现；从侧栏去别处就等于看过、关掉了。
      setImportSummaryView(null);
      setView(next);
    },
    [clearAll],
  );

  const openCategory = useCallback(
    (kind: CategoryKind, name: string, origin?: { src: string; rect: DOMRect }) => {
      if (origin) setFlyCover({ src: origin.src, rect: origin.rect, key: Date.now() });
      clearAll();
      if (kind === "tags") setTags([name]);
      else if (kind === "scenes") setScene(name);
      else if (kind === "people") setPerson(name);
      else setPlace(name);
      setView("library");
    },
    [clearAll],
  );

  const openMonth = useCallback(
    (month: string, origin?: { src: string; rect: DOMRect }) => {
      if (origin) setFlyCover({ src: origin.src, rect: origin.rect, key: Date.now() });
      clearAll();
      setDayFrom(month + "-01");
      setDayTo(month + "-31");
      setView("library");
    },
    [clearAll],
  );

  useEffect(() => {
    if (view === "tags" || view === "people" || view === "places") {
      setCatKind(view);
    }
  }, [view]);

  const loadMore = useCallback(() => {
    if (loadingMore || !hasMore || view !== "library") return;
    const last = assets[assets.length - 1];
    // 有 taken_at 就走 keyset 游标（深翻页不随页数变慢）；缺失时退回 offset。
    // taken_at 为空也照样给游标（空串），由服务端 COALESCE 处理；
    // 退回 offset 会让 NULL 行在深翻页时被重复或跳过。
    // 按月看时服务端按美学分排序，游标要带分数：score|taken_at|id
    const cursor =
      last && sort === "taken_desc"
        ? dayFrom && dayTo
          ? [last.score ?? -1, last.taken_at ?? "", last.id].join("|")
          : [last.taken_at ?? "", last.id].join("|")
        : undefined;
    setLoadingMore(true);
    queryAssets({
      query: query || undefined,
      tag: isFixture && fixtureUserTags[tags[0]] ? undefined : tags[0],
      album: album ?? undefined,
      scene: scene || undefined,
      person: person || undefined,
      place: place || undefined,
      day_from: dayFrom ?? undefined,
      day_to: dayTo ?? undefined,
      limit: PAGE_SIZE,
      cursor,
      offset: cursor ? 0 : assets.length,
      sort,
    })
      .then((list) => {
        setAssets((previous) => [...previous, ...list]);
        setHasMore(list.length === PAGE_SIZE);
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setLoadingMore(false));
  }, [loadingMore, hasMore, view, query, tagKey, tags, album, scene, person, place, dayFrom, dayTo, assets, sort, fixtureUserTags]);

  const navigateDetail = useCallback(
    (delta: number) => {
      if (!detailAsset || !currentList.length) return;
      const index = currentList.findIndex((asset) => asset.id === detailAsset.id);
      const next = currentList[index + delta];
      if (!next) {
        // 已加载的这一页到头了：先补一页，拿到新数据后在下面的 effect 里继续前进
        if (delta > 0 && hasMore && !loadingMore) {
          pendingDetailStep.current = delta;
          loadMore();
        }
        return;
      }
      setDetailDeleteError(null);
      setDetailStep(delta);
      setDetailId(next.id);
      setSelection([next.id]);
      setAnchorId(next.id);
    },
    [currentList, detailAsset, hasMore, loadingMore, loadMore],
  );

  // 补完一页后把刚才按下的“下一张”补上
  useEffect(() => {
    const step = pendingDetailStep.current;
    if (!step) return;
    if (loadingMore) return;
    const index = currentList.findIndex((asset) => asset.id === detailId);
    const next = currentList[index + step];
    pendingDetailStep.current = 0;
    if (!next) return;
    setDetailId(next.id);
    setSelection([next.id]);
    setAnchorId(next.id);
  }, [currentList, detailId, loadingMore]);

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
      // 焦点落在交互元素上时，Enter/Space 属于它的激活键，不能被网格的快捷键吃掉。
      const onInteractive = !!target?.closest?.(
        'button, a[href], input, select, textarea, [contenteditable="true"], [role="button"], [role="tab"], [role="menuitem"], [role="switch"]',
      );
      const activationKey = event.key === "Enter" || event.key === " " || event.key === "Spacebar";

      // ⌘K 自己负责开合，弹窗里不响应
      if (meta && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (detailAsset || recognitionOpen || deleteOpen || importPlan) return;
        if (paletteOpen) setPaletteOpen(false);
        else openPalette();
        return;
      }
      // 面板打开时，其余快捷键与网格操作都让路（Esc / ↑↓ / ⏎ / Tab 面板自己处理）
      if (paletteOpen) return;
      // 弹窗自己处理 Esc / Tab（useDialogFocus 在捕获阶段拦截），这里不重复处理。
      if (recognitionOpen) return;
      if ((deleteOpen || importPlan || spaceClean) && event.key === "Escape") return;

      if (onInteractive && activationKey && !meta) return;

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
        openPalette();
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
        // 用屏上实际渲染的那份列表：折叠掉的重复项不该被“全选”选中。
        setSelection(currentList.map((asset) => asset.id));
        return;
      }

      if (detailAsset) {
        // Backspace/Delete 交给 Detail 自己的监听：它只弹确认，不会直接删。
        if (event.key === "Backspace" || event.key === "Delete") return;
        if (event.key === "Escape" || event.key === " ") {
          event.preventDefault();
          closeDetail();
        } else if (event.key === "ArrowLeft") {
          event.preventDefault();
          navigateDetail(-1);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          navigateDetail(1);
        }
        return;
      }

      // 整理/空间/设置视图没有网格快捷键，但焦点所在元素上的 Enter/Space 已经在上方放行
      if (view === "organize" || view === "settings" || view === "space") return;

      if (typing) {
        if (event.key === "Escape") {
          if (queryInput) clearSearch();
          target?.blur();
        }
        return;
      }

      if (event.key === "Escape") {
        if (selectMode) {
          setSelectMode(false);
          setSelection([]);
        } else if (active) clearAll();
        else setSelection([]);
        return;
      }

      if (view !== "library" || currentList.length === 0) return;
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter"].includes(event.key)) return;
      event.preventDefault();

      if (event.key === "Enter") {
        const asset = currentList.find((item) => item.id === anchorId) ?? currentList[0];
        openDetail(asset);
        return;
      }

      const currentIndex = Math.max(0, currentList.findIndex((asset) => asset.id === anchorId));
      let nextIndex = currentIndex;
      if (event.key === "ArrowLeft") nextIndex = Math.max(0, currentIndex - 1);
      if (event.key === "ArrowRight") nextIndex = Math.min(currentList.length - 1, currentIndex + 1);
      if (event.key === "ArrowUp") nextIndex = Math.max(0, currentIndex - columns);
      if (event.key === "ArrowDown") nextIndex = Math.min(currentList.length - 1, currentIndex + columns);
      const nextAsset = currentList[nextIndex];
      if (!nextAsset) return;
      if (event.shiftKey) {
        const from = Math.min(currentIndex, nextIndex);
        const to = Math.max(currentIndex, nextIndex);
        setSelection(currentList.slice(from, to + 1).map((asset) => asset.id));
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
    closeDetail,
    navigateDetail,
    queryInput,
    clearSearch,
    active,
    clearAll,
    view,
    currentList,
    anchorId,
    columns,
    openDetail,
    navigate,
    recognitionOpen,
    selectMode,
    deleteOpen,
    spaceClean,
    importPlan,
    paletteOpen,
    openPalette,
  ]);

  // 选中条被卸载时（取消选择、批量操作完成），焦点会掉到 body；交回原来那张缩略图。
  const selectionWasFocused = useRef(false);
  useEffect(() => {
    if (selection.length > 0) {
      selectionWasFocused.current = true;
      return;
    }
    if (!selectionWasFocused.current) return;
    selectionWasFocused.current = false;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const target = anchorId
      ? document.querySelector<HTMLElement>(`[data-asset-id="${anchorId}"]`)
      : null;
    target?.focus({ preventScroll: true });
  }, [selection.length, anchorId]);

  // 视图切换时的进入方向：按侧栏顺序，往下走就从下方进，往上走就从上方进。
  const VIEW_ORDER: View[] = ["library", "timeline", "albums", "tags", "people", "places", "organize", "settings"];
  const lastViewRef = useRef<View>(view);
  const viewDirRef = useRef<"up" | "down" | "none">("none");
  if (lastViewRef.current !== view) {
    const from = VIEW_ORDER.indexOf(lastViewRef.current);
    const to = VIEW_ORDER.indexOf(view);
    viewDirRef.current = from < 0 || to < 0 || from === to ? "none" : to > from ? "down" : "up";
    lastViewRef.current = view;
  }

  const range = yearRange(stats);
  const categoryCount = view === "organize" ? (allAssets?.length ?? 0) : (stats?.assets ?? 0);
  const title = (() => {
    if (view === "space") return "图库清理";
    if (view === "organize") return "整理视图";
    if (view === "settings") return "设置";
    if (album) return `相册 · ${album}`;
    if (query) return `搜索 “${query}”`;
    if (view === "timeline") return "时间线";
    if (view === "albums") return "相册";
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
    view === "space"
      ? "按体积清理 · 待清理只记清单"
      : view === "organize"
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

  // 每个生效条件一条：顺序按「关键词 → 标签 → 人物 → 地点 → 场景 → 日期 → 相册」，
  // 和侧栏从上到下的读取顺序一致，用户扫一眼就知道结果为什么变少。
  const conditions: { key: string; label: string; remove: () => void }[] = [];
  if (query) conditions.push({ key: "query", label: `关键词：「${query}」`, remove: clearSearch });
  for (const tag of tags) {
    conditions.push({
      key: `tag-${tag}`,
      label: `标签：${tag}`,
      remove: () => setTags((previous) => previous.filter((item) => item !== tag)),
    });
  }
  if (person) conditions.push({ key: "person", label: `人物：${person}`, remove: () => setPerson(null) });
  if (place) conditions.push({ key: "place", label: `地点：${place}`, remove: () => setPlace(null) });
  if (scene) conditions.push({ key: "scene", label: `场景：${scene}`, remove: () => setScene(null) });
  if (dayFrom || dayTo) {
    conditions.push({
      key: "day",
      label: `日期：${dayFrom || "最早"} ~ ${dayTo || "今天"}`,
      remove: () => {
        setDayFrom(null);
        setDayTo(null);
      },
    });
  }
  if (album) conditions.push({ key: "album", label: `相册：${album}`, remove: () => setAlbum(null) });

  // ⌘K 面板：跳转 + 从 facets 里取的热门筛选 + 直接搜索
  const paletteSections = useMemo(() => {
    const q = queryInput.trim().toLowerCase();
    const hit = (text: string) => !q || text.toLowerCase().includes(q);
    const sections: PaletteSection[] = [];

    if (queryInput.trim()) {
      const value = queryInput.trim();
      sections.push({
        label: "搜索",
        items: [{
          id: "search-query",
          title: `搜索「${value}」`,
          subtitle: "在全部照片中查找",
          icon: Search,
          keycap: "⏎",
          run: () => {
            setView("library");
            setQuery(value);
          },
        }],
      });
    }

    const jumps: PaletteItem[] = [
      { id: "view-library", title: "全部照片", subtitle: `${stats?.assets ?? 0} 张`, icon: Images, keycap: "⌘1", run: () => navigate("library") },
      { id: "view-timeline", title: "时间线", subtitle: "按月份回看", icon: Clock, keycap: "⌘2", run: () => navigate("timeline") },
      { id: "view-space", title: "图库清理", subtitle: "按体积清理 · 带播放器", icon: HardDrive, run: () => navigate("space") },
      { id: "view-tags", title: "分类浏览", subtitle: "标签 · 人物 · 地点", icon: Tags, run: () => navigate("tags") },
      { id: "view-organize", title: "整理视图", subtitle: "AI 归位预演", icon: Sparkles, run: () => navigate("organize") },
      { id: "view-settings", title: "设置", subtitle: "本地库 · 模型 · 缓存", icon: Settings, keycap: "⌘,", run: () => navigate("settings") },
    ].filter((item) => hit(item.title)) as PaletteItem[];
    if (jumps.length) sections.push({ label: "跳转", items: jumps });

    const tags = (displayFacets?.tags ?? []).filter(([name]) => hit(name)).slice(0, 5)
      .map<PaletteItem>(([name, count]) => ({
        id: `tag-${name}`, title: name, subtitle: `标签 · ${count} 张`, icon: Tags,
        run: () => { toggleTag(name); },
      }));
    if (tags.length) sections.push({ label: "标签", items: tags });

    const people = (displayFacets?.people ?? []).filter(([name]) => hit(name)).slice(0, 4)
      .map<PaletteItem>(([name, count]) => ({
        id: `person-${name}`, title: name, subtitle: `人物 · ${count} 张`, icon: Users,
        run: () => { setView("library"); setPerson(name); setDetailId(null); },
      }));
    if (people.length) sections.push({ label: "人物", items: people });

    const places = (displayFacets?.places ?? []).filter(([name]) => hit(name)).slice(0, 4)
      .map<PaletteItem>(([name, count]) => ({
        id: `place-${name}`, title: name, subtitle: `地点 · ${count} 张`, icon: MapPin,
        run: () => { setView("library"); setPlace(name); setDetailId(null); },
      }));
    if (places.length) sections.push({ label: "地点", items: places });

    const albums = (displayFacets?.albums ?? []).filter(([name]) => hit(name)).slice(0, 4)
      .map<PaletteItem>(([name, count]) => ({
        id: `album-${name}`, title: name, subtitle: `相册 · ${count} 张`, icon: Folder,
        run: () => { setView("library"); setAlbum(name); },
      }));
    if (albums.length) sections.push({ label: "相册", items: albums });

    return sections;
  }, [queryInput, displayFacets, stats, navigate, toggleTag]);

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

    if (importSummaryView) {
      return (
        <ImportSummaryView
          summary={importSummaryView.data}
          added={importSummaryView.added}
          firstImport={importSummaryView.first}
          onBrowse={() => {
            setImportSummaryView(null);
            navigate("library");
          }}
          onCleanup={() => {
            setImportSummaryView(null);
            navigate("space");
          }}
          onRecognize={() => {
            setImportSummaryView(null);
            setRecognitionOpen(true);
          }}
        />
      );
    }

    if (view === "space") {
      return (
        <SpaceView
          onOpenDetail={(entry, list) => openSpacePreview(entry, list)}
          onClean={openSpaceClean}
          onToast={showToast}
          onError={showError}
          onProgress={showProgress}
          onProgressDone={settleProgress}
          onOpenQueue={() => {
            // 批量加入后从 toast 打开清单：切到图库清理并展开抽屉。
            setView("space");
            setSpaceQueueSignal((value) => value + 1);
          }}
          openQueueSignal={spaceQueueSignal}
          dataVersion={dataVersion}
          onRows={setSpacePreviewList}
        />
      );
    }

      if (folderImport && folderImportOpen) {
        return (
          <ImportProgressView
            progress={folderImport}
            busy={folderImportBusy}
            failed={Boolean(folderImportError)}
            onBackground={() => setFolderImportOpen(false)}
            onCancel={() => {
              setFolderImportOpen(false);
              showToast("导入在后台继续");
            }}
            onRetry={() => {
              if (folderTarget.current) void runFolderImport(folderTarget.current);
            }}
            onPickAnother={() => {
              setFolderImport(null);
              setFolderImportOpen(false);
              void handleEmptyChoice("扫描本地文件夹");
            }}
          />
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

    if (view === "albums") {
      return (
        <Albums
          albums={albums ?? []}
          loading={albums === null}
          onPick={(name) => {
            clearAll();
            setAlbum(name);
            setView("library");
          }}
        />
      );
    }

    if (view === "tags" || view === "people" || view === "places") {
      return (
        <Categories
          kind={catKind}
          groups={groups ?? []}
          loading={groups === null}
          onPick={openCategory}
          onKindChange={(next) => setCatKind(next)}
        />
      );
    }

    if (view === "timeline") {
      if (months === null) return <LoadingState label="正在整理时间线…" />;
      if (months.length === 0) return <EmptyState onChoose={handleEmptyChoice} />;
      return <Timeline months={months} onOpenMonth={openMonth} />;
    }

    if (loading && assets.length === 0) return <LoadingState label="正在读取本地相册…" />;
    if (!loading && (stats?.assets === 0 || (assets.length === 0 && !active))) return <EmptyState onChoose={handleEmptyChoice} />;
    if (!loading && active && filteredAssets.length === 0) {
      // 空结果里也能逐条去掉条件，和网格上方的 chip 条同一套语义。
      return (
        <EmptyState
          mode="search"
          onChoose={handleEmptyChoice}
          onReset={clearAll}
          conditions={conditions}
        />
      );
    }
    return (
      <div className="grid-wrap">
        {loading && <div className="content-loading-bar" />}
        {/* 不按筛选条件重建组件：保住上一批卡片的位置，让它们 FLIP 到新位置，
            而不是整块网格消失再出现 */}
        <VirtualGrid
          assets={displayAssets}
          dupCounts={dupCounts}
          columns={columns}
          density={density}
          selection={new Set(selection)}
          multi={selection.length > 1}
          selectMode={selectMode}
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
        placeTotal={placeTotal ?? 0}
        onNavigate={navigate}
        onTag={toggleTag}
        onAlbum={(name) => {
          setView("library");
          setAlbum((current) => (current === name ? null : name));
        }}
        onPerson={(name) => {
          setView("library");
          setPerson((current) => (current === name ? null : name));
          setDetailId(null);
        }}
        onPlace={(name) => {
          setView("library");
          setPlace((current) => (current === name ? null : name));
          setDetailId(null);
        }}
        onSearch={(rect?: DOMRect) => openPalette(rect)}
        liveStatus={{
          status: live.view.status,
          done: Math.min(live.view.total, live.view.done),
          total: Math.max(0, live.view.total),
          rate: live.view.rate,
          paused: live.view.paused,
        }}
        onRecognition={(rect?: DOMRect) => {
          if (rect) {
            setDialogRect({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
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
          onSearchOpen={(rect: DOMRect) => openPalette(rect)}
          onSearchClear={clearSearch}
          density={density}
          onDensity={setDensity}
          sort={sort}
          onSort={setSort}
          selectMode={selectMode}
          onSelectMode={(next: boolean) => {
            setSelectMode(next);
            if (!next) setSelection([]);
          }}
          view={view}
          onView={navigate}
          minimal={view === "organize" || view === "settings"}
          hideGridTools={view === "space"}
          theme={theme}
          onTheme={setTheme}
        />

        {/* 没有任何条件时整条不渲染：不留空白，也不占一次布局 */}
        {view !== "organize" && view !== "settings" && view !== "space" && conditions.length > 0 && (
          <div className="condition-slot" data-open="true">
          <div className="condition-bar">
            <div className="result-count">
              <Search size={12} strokeWidth={1.8} />
              <span>{count}{active && assets.length >= 1000 && view === "library" ? "+" : ""} 张结果</span>
            </div>
            <div className="chip-row filter-chips">
              {conditions.map((condition) => (
                <span className="chip" key={condition.key} data-condition={condition.key}>
                  {condition.label}
                  <button
                    type="button"
                    onClick={condition.remove}
                    aria-label={`移除 ${condition.label}`}
                    title={`移除 ${condition.label}`}
                  >
                    <X size={11} strokeWidth={2} />
                  </button>
                </span>
              ))}
              {conditions.length > 1 && (
                <button type="button" className="clear-all" onClick={clearAll}>清除全部</button>
              )}
            </div>
            <div className="sort-note">{SORT_LABELS[sort]}</div>
          </div>
          </div>
        )}

        <section className={clsx("content", view === "timeline" && "timeline-content")}>
          <div className="view-shell" key={view} data-enter={viewDirRef.current}>{content}</div>
        </section>
      </main>

      {detailAsset && (
        <Detail
          asset={detailAsset}
          dup={dupIndex.get(detailAsset.id)}
          index={Math.max(0, detailIndex)}
          // 全部加载完时用实际列表长度，避免计数器和是否能翻页各说一套
          total={
            view === "library" && !hasMore
              ? currentList.length
              : view === "library"
                ? (monthTotal ?? Math.max(detailTotal, stats?.assets ?? 0))
                : detailTotal
          }
          origin={detailOrigin}
          step={detailStep}
          onClose={closeDetail}
          closing={detailClosing}
          onPrev={() => navigateDetail(-1)}
          onNext={() => navigateDetail(1)}
          canNext={detailIndex < currentList.length - 1 || (view === "library" && hasMore)}
          onTag={applyTag}
          actions={{
            onRecognize: () => void recognizeOne(detailAsset),
            onAddToAlbum: () => setAlbumPick({ ids: [detailAsset.id] }),
            onExport: () => void exportOne(detailAsset),
            onReveal: () => {
              void revealInFinder(detailAsset.path).catch((err: unknown) =>
                showError(`在 Finder 中显示失败：${extractMessage(err)}`),
              );
            },
            onOpenExternal: () =>
              void openExternal(detailAsset.path).catch((err: unknown) =>
                showError(`外部播放器打不开：${extractMessage(err)}`),
              ),
          }}
          onDelete={() =>
            askDeleteDetail(
              document.querySelector<HTMLElement>(".inspector-delete")?.getBoundingClientRect() ?? null,
            )
          }
          deleteError={detailDeleteError}
          deleting={deleting}
          recognition={recognizing}
          exporting={detailExporting}
        />
      )}

      <RecognitionDialog
        open={recognitionOpen}
        live={live}
        originRect={dialogRect}
        assets={new Map([...assets, ...(allAssets ?? [])].map((asset) => [asset.id, asset]))}
        onClose={closeRecognition}
        closing={dialogClosing}
        onImported={refreshData}
      />

      {selection.length > 0 && !detailAsset && (
        <SelectionBar
          count={selection.length}
          origin={selectionOrigin}
          busy={bulkBusy}
          tagContext={tags.length === 1 && userTagNames.has(tags[0]) ? tags[0] : null}
          albumContext={album}
          onOpenTag={() => setTagPick(true)}
          onOpenAlbum={() => setAlbumPick({ ids: [...selection] })}
          onRemoveTag={(tag) => void runRemove("tag", tag)}
          onRemoveAlbum={(name) => void runRemove("album", name)}
          onDelete={(rect: DOMRect) => {
            setDialogRect({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
            setDeleteOpen(true);
          }}
          onClear={() => setSelection([])}
        />
      )}

      {spaceClean && (
        <DeleteDialog
          count={spaceClean.ids.length}
          bytes={spaceClean.bytes}
          origin={dialogRect}
          busy={deleting}
          onCancel={() => setSpaceClean(null)}
          onConfirm={() => void confirmSpaceClean()}
        />
      )}

      {detailDelete && detailAsset && (
        <DeleteDialog
          count={1}
          title="删除这一张？"
          note="原图移到废纸篓，记录一并删除。"
          origin={
            detailDelete.origin
              ? { x: detailDelete.origin.left, y: detailDelete.origin.top, width: detailDelete.origin.width, height: detailDelete.origin.height }
              : null
          }
          busy={deleting}
          onCancel={() => setDetailDelete(null)}
          onConfirm={() => void confirmDetailDelete()}
        />
      )}

      {tagPick && (
        <TagPicker
          tags={displayFacets?.user_tags ?? []}
          count={selection.length}
          onApply={runBulkTag}
          onCancel={() => setTagPick(false)}
        />
      )}

      {albumPick && (
        <AlbumPicker
          assetIds={albumPick.ids}
          onCancel={() => setAlbumPick(null)}
          onAdded={(album, created) => {
            if (albumPick.ids.length > 1) {
              void runBulkAlbum(albumPick.ids, album);
              return;
            }
            setAlbumPick(null);
            refreshData();
            showToast(created ? `已新建相册「${album}」并加入` : `已加入相册「${album}」`);
          }}
        />
      )}

      {deleteOpen && (
        <DeleteDialog
          count={selection.length}
          origin={dialogRect}
          busy={deleting}
          onCancel={() => setDeleteOpen(false)}
          onConfirm={() => void confirmDelete()}
        />
      )}

      {blockedRoots && (
        <AccessDialog
          roots={blockedRoots}
          onOpenSettings={() => void openPrivacySettings()}
          onRecheck={checkAccess}
          onDismiss={() => setBlockedRoots(null)}
        />
      )}

      {importPlan && (
        <ImportDialog
          origin={null}
          plan={importProgress ? null : importPlan}
          progress={importProgress}
          busy={importBusy}
          authError={importAuthError}
          onCancel={() => {
            if (importBusy) showToast("导入继续在后台进行");
            setImportPlan(null);
            setImportProgress(null);
            setImportAuthError(false);
          }}
          onConfirm={() => void runImportDownload()}
          onRetryAuth={() => void runImportPlan()}
        />
      )}

      {flyCover && (
        <FlyingCover
          key={flyCover.key}
          src={flyCover.src}
          from={flyCover.rect}
          onDone={() => setFlyCover(null)}
        />
      )}

      <CommandPalette
        open={paletteOpen}
        origin={paletteOrigin}
        query={queryInput}
        onQueryChange={handleSearchChange}
        sections={paletteSections}
        onClose={() => setPaletteOpen(false)}
      />


      {folderImport && !folderImportOpen && (
        <ImportMiniBar
          progress={folderImport}
          failure={folderImportError ? { message: folderImportError } : null}
          onExpand={() => setFolderImportOpen(true)}
          onDismiss={() => {
            setFolderImport(null);
            setFolderImportError(null);
          }}
        />
      )}
      {toast && (
        <div
          className={clsx(
            "toast glass-surface",
            `toast-${toast.kind}`,
            selection.length > 0 && "raised",
          )}
          role={toast.kind === "sticky" ? "alert" : "status"}
          data-kind={toast.kind}
        >
          {toast.kind === "progress" && <LoaderCircle size={13} className="spin" />}
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
          {toast.kind === "sticky" && (
            <button type="button" className="toast-close" onClick={() => setToast(null)} aria-label="关闭提示">
              <X size={12} strokeWidth={2} />
            </button>
          )}
          {toast.kind === "action" && toast.duration ? (
            <span className="toast-ring" aria-hidden="true" />
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * 分类卡 / 月份行的封面飞进工具栏标题区：落到位后停一下再淡出，
 * 所以静止状态和以前完全一样（工具栏里不会多出常驻元素）。
 */
function FlyingCover({ src, from, onDone }: { src: string; from: DOMRect; onDone: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const target = document.querySelector<HTMLElement>(".title-block")?.getBoundingClientRect();
    if (reduced || !target) {
      onDone();
      return;
    }
    const size = 26;
    const left = target.left - size - 10;
    const top = target.top + 4;
    const dx = left - from.left;
    const dy = top - from.top;
    const scale = size / from.width;
    const animation = el.animate(
      [
        { transform: "none", opacity: 1, borderRadius: "var(--radius-10)" },
        { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, opacity: 0.9, borderRadius: "8px" },
      ],
      { duration: 320, easing: "cubic-bezier(.32,.72,0,1)", fill: "forwards" },
    );
    animation.finished.then(() => {
      el.animate([{ opacity: 0.9 }, { opacity: 0 }], { duration: 220, easing: "ease-out", fill: "forwards" })
        .finished.then(onDone, onDone);
    }, onDone);
    // 只跑一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div
      ref={ref}
      className="flying-cover"
      aria-hidden="true"
      style={{ left: from.left, top: from.top, width: from.width, height: from.height }}
    >
      <img src={src} alt="" />
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
