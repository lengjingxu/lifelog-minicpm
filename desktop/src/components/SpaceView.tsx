import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import clsx from "clsx";
import {
  Check,
  ImageOff,
  Info,
  LoaderCircle,
  Play,
  Search,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import {
  assetSrc,
  cleanupAdd,
  cleanupAddAllDup,
  cleanupList,
  cleanupRemove,
  dedupBuild,
  dupGroupPage,
  queryAssets,
  spaceGroups,
  spaceVersions,
  spaceViews,
  type Asset,
  type CleanupEntry,
  type CleanupList,
  type DupGroupPageGroup,
  type SpaceGroup,
  type SpaceViewKey,
  type SpaceViews,
} from "../api";
import { GAP, formatBytes } from "../utils";
import { reducedMotion } from "../motion";
import { DupGroupBoard } from "./DupGroupBoard";

const PAGE_SIZE = 200;
const CARD_MIN_WIDTH = 158;

type SpaceViewItem = { key: SpaceViewKey; label: string; hint: string };

const VIEWS: SpaceViewItem[] = [
  { key: "large", label: "全部大文件", hint: "按文件体积从大到小" },
  { key: "dup", label: "重复图", hint: "按 dhash 指纹分组的重复照片" },
  { key: "screenshot", label: "屏幕截图", hint: "路径 + scene/tags 两层筛选" },
  { key: "video", label: "视频", hint: "kind = video" },
  { key: "photo", label: "照片", hint: "kind = image" },
];

/** 统计要区分「0 B」和「读不到」，不能用 — 表示空。 */
function statBytes(bytes: number): string {
  return bytes > 0 ? formatBytes(bytes) : "0 B";
}

export function entryFromAsset(asset: Asset): CleanupEntry {
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

/** 清单里只有 id/路径/大小；预览用详情组件需要完整的 Asset 形状。 */
export function assetFromEntry(entry: CleanupEntry): Asset {
  return {
    id: entry.asset_id,
    path: entry.path,
    thumb: entry.thumb ?? "",
    original: entry.path,
    day: entry.day,
    taken_at: entry.taken_at,
    kind: entry.kind,
    caption: null,
    scene: null,
    people: null,
    place: null,
    activity: null,
    mood: null,
    tags: [],
    ocr_text: null,
    size: entry.size,
  };
}

type Props = {
  /** 打开大图详情（图片/视频通用）。list 是当前已载入的这一页，详情里可以前后翻页。 */
  onOpenDetail: (entry: CleanupEntry, list: Asset[]) => void;
  /** 交给 App 统一渲染删除确认（DeleteDialog）。 */
  onClean: (ids: string[], rect: DOMRect) => void;
  /** 成功/可撤销提示（App 的 showToast 分类）。 */
  onToast: (
    text: string,
    options?: { label: string; run: () => void } | { kind?: "status" | "action" | "sticky" | "progress"; action?: { label: string; run: () => void } },
  ) => void;
  /** 失败提示：常驻，等用户手动关。 */
  onError: (text: string) => void;
  /** 进度提示：完成后在同一位置变成结果。 */
  onProgress: (text: string) => void;
  onProgressDone: (result: { text: string; action?: { label: string; run: () => void } }) => void;
  /** 打开清单抽屉。 */
  onOpenQueue: () => void;
  /** App 层递增：从 toast 里点「查看清单」时用它打开抽屉。 */
  openQueueSignal?: number;
  /** 真实清理成功后 App 会加一，用来重新拉清单和统计。 */
  dataVersion: number;
  /** 已载入的这一页同步给 App，预览翻页就在这一页里走。 */
  onRows: (rows: Asset[]) => void;
};

export function SpaceView({ onOpenDetail, onClean, onToast, onError, onProgress, onProgressDone, onOpenQueue, openQueueSignal = 0, dataVersion, onRows }: Props) {
  const [view, setView] = useState<SpaceViewKey>("large");
  const [views, setViews] = useState<SpaceViews | null>(null);
  const [groups, setGroups] = useState<SpaceGroup[]>([]);
  // 重复图分组视图：按 20 组分页，切视角/卸载时清空。
  const [dupGroups, setDupGroups] = useState<DupGroupPageGroup[]>([]);
  const [dupTotalGroups, setDupTotalGroups] = useState(0);
  const [dupLoadingMore, setDupLoadingMore] = useState(false);
  const [groupsTotal, setGroupsTotal] = useState(0);
  const [version, setVersion] = useState("");
  const [rows, setRows] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queue, setQueue] = useState<CleanupList | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filterInput, setFilterInput] = useState("");
  const [pathFilter, setPathFilter] = useState("");
  const [computing, setComputing] = useState(false);
  const [allBusy, setAllBusy] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  useEffect(() => {
    if (openQueueSignal > 0) setQueueOpen(true);
  }, [openQueueSignal]);
  const [gridWidth, setGridWidth] = useState(0);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const requestId = useRef(0);
  const filterTimer = useRef<number | undefined>(undefined);
  const cleanedVersion = useRef(dataVersion);
  const anchorRef = useRef<string | null>(null);
  // 重复图组里「点任意一张 = 整组切换」需要成员 id；按组缓存，不放进 chip payload。
  const groupIdsRef = useRef<Record<string, string[]>>({});
  // FLIP：记住上一帧每张卡的位置，删除/移出后只补间 transform。
  const prevRects = useRef<Map<string, DOMRect>>(new Map());
  const thumbById = useRef<Map<string, { thumb: string; size: number | null }>>(new Map());
  const flyRootRef = useRef<HTMLDivElement | null>(null);
  const flyingRef = useRef(0);
  // 正在播「离开」的卡片数：>0 时补位延后到 640ms。
  const vanishRef = useRef(0);

  const queueIds = useMemo(() => new Set((queue?.items ?? []).map((item) => item.asset_id)), [queue]);
  const rowById = useMemo(() => new Map(rows.map((asset) => [asset.id, asset])), [rows]);
  useEffect(() => {
    // 卡片消失后替身层要用它的缩略图，先按 id 留住。
    const map = new Map(thumbById.current);
    for (const asset of rows) map.set(asset.id, { thumb: asset.thumb, size: asset.size ?? null });
    thumbById.current = map;
  }, [rows]);
  const columns = Math.max(2, Math.min(6, Math.floor((gridWidth + GAP) / (CARD_MIN_WIDTH + GAP))));

  // 进待清理的卡片离开网格，剩下的补位；移出时再回来。
  const visibleRows = useMemo(
    () => rows.filter((asset) => !queueIds.has(asset.id)),
    [rows, queueIds],
  );

  // 一屏只出现一次的数字：面板头用这一句，胶囊只留名字。
  const summaryLine = currentStatLine(views, view, loading);

  const refreshQueue = useCallback(async () => {
    try {
      setQueue(await cleanupList());
    } catch (reason) {
      onError("读取待清理清单失败：" + String(reason));
    }
  }, [onToast]);

  const refreshStats = useCallback(async () => {
    try {
      const [nextViews, nextVersions] = await Promise.all([spaceViews(), spaceVersions()]);
      setViews(nextViews);
      setVersion(nextVersions.version);
    } catch {
      // 统计失败不挡列表
    }
  }, []);

  useEffect(() => {
    void refreshQueue();
    void refreshStats();
  }, [refreshQueue, refreshStats, dataVersion]);

  useEffect(() => {
    if (dataVersion === cleanedVersion.current) return;
    cleanedVersion.current = dataVersion;
    void refreshQueue();
    void refreshStats();
  }, [dataVersion, refreshQueue, refreshStats]);

  // 分组只跟「视角 + 库内容指纹」有关；重复图只需要总数与可回收体积。
  useEffect(() => {
    if (view !== "dup" && view !== "screenshot") {
      setGroups([]);
      setGroupsTotal(0);
      return;
    }
    let alive = true;
    if (view === "dup") {
      // 重复图走分组视图：一次 20 组，组内自带成员（keeper 第一、按分排序）。
      setDupGroups([]);
      setDupLoadingMore(false);
      dupGroupPage({ limit: 1, offset: 0 })
        .then((page) => {
          if (!alive) return;
          setDupTotalGroups(page.total_groups);
          setGroupsTotal(page.total_groups);
        })
        .catch(() => {
          if (alive) setGroupsTotal(0);
        });
      return () => {
        alive = false;
      };
    }
    spaceGroups(view, {})
      .then((result) => {
        if (!alive) return;
        setGroups(result.groups);
        setGroupsTotal(result.total ?? result.groups.length);
      })
      .catch(() => {
        if (alive) setGroups([]);
      });
    return () => {
      alive = false;
    };
  }, [view, version]);

  /** 重复图分组分页：首屏 20 组，滚到底再取 20 组。 */
  const loadDupGroups = useCallback(
    async (offset: number) => {
      setDupLoadingMore(true);
      try {
        const page = await dupGroupPage({ limit: 20, offset });
        // 切视角/重新加载后旧请求的结果不能写进新列表。
        setDupGroups((previous) => {
          if (offset === 0) return page.groups;
          const seen = new Set(previous.map((group) => group.key));
          return [...previous, ...page.groups.filter((group) => !seen.has(group.key))];
        });
        setDupTotalGroups(page.total_groups);
        setGroupsTotal(page.total_groups);
      } catch (reason) {
        onError("读取重复组失败：" + String(reason));
      } finally {
        setDupLoadingMore(false);
      }
    },
    [onError],
  );

  // 进入重复图：先拉第一页；离开就清空，避免内存堆积。
  useEffect(() => {
    if (view !== "dup") {
      setDupGroups([]);
      return;
    }
    setDupGroups([]);
    void loadDupGroups(0);
    return () => setDupGroups([]);
  }, [view, version, loadDupGroups]);

  const computeDup = useCallback(async () => {
    if (computing) return;
    setComputing(true);
    try {
      const result = (await dedupBuild()) as { errors?: number } | null;
      onToast(
        result && typeof result.errors === "number" && result.errors > 0
          ? "指纹已计算，仍有 " + result.errors + " 张失败"
          : "指纹已计算完成",
      );
      void refreshStats();
    } catch (reason) {
      onError("计算指纹失败：" + String(reason));
    } finally {
      setComputing(false);
    }
  }, [computing, onToast, refreshStats]);

  const fetchPage = useCallback(async (offset: number) => {
    if (offset === 0) setLoading(true);
    else setLoadingMore(true);
    const ticket = ++requestId.current;
    try {
      const page = await queryAssets({
        limit: PAGE_SIZE,
        offset,
        sort: "size_desc",
        view,
        query: pathFilter || undefined,
      });
      if (ticket !== requestId.current) return;
      setRows((previous) => (offset === 0 ? page : [...previous, ...page]));
      setHasMore(page.length === PAGE_SIZE);
      setError(null);
    } catch (reason) {
      if (ticket === requestId.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (ticket === requestId.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [pathFilter, view]);

  useEffect(() => {
    setRows([]);
    setFocusId(null);
    void fetchPage(0);
  }, [fetchPage, dataVersion]);

  useEffect(() => {
    onRows(rows);
  }, [onRows, rows]);

  useEffect(() => {
    const node = gridRef.current;
    if (!node) return;
    const measure = () => setGridWidth(node.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const loadMore = useCallback(() => {
    if (loading || loadingMore || !hasMore) return;
    void fetchPage(rows.length);
  }, [fetchPage, hasMore, loading, loadingMore, rows.length]);

  /** 重复图分组视图的「加载下一批」：一次 +20 组。 */
  const loadMoreDup = useCallback(() => {
    if (dupLoadingMore) return;
    if (dupGroups.length >= dupTotalGroups) return;
    void loadDupGroups(dupGroups.length);
  }, [dupGroups.length, dupLoadingMore, dupTotalGroups, loadDupGroups]);

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          if (view === "dup") loadMoreDup();
          else loadMore();
        }
      },
      { root: scrollRef.current, rootMargin: "600px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [loadMore, loadMoreDup, view]);

  // 乐观更新：点一下立刻变勾；请求失败回滚。
  const applyQueueRef = useRef<(ids: string[], add: boolean) => void>(() => {});

  const applyQueue = useCallback(
    (ids: string[], add: boolean) => {
      const unique = Array.from(new Set(ids));
      if (!unique.length) return;
      const known = unique
        .map((id) => rowById.get(id))
        .filter((asset): asset is Asset => Boolean(asset));
      const snapshot = queue;
      const unknown = unique.filter((id) => !rowById.has(id));
      setQueue((previous) => {
        const base = previous ?? { items: [], count: 0, bytes: 0 };
        if (add) {
          const existing = new Set(base.items.map((item) => item.asset_id));
          const added: CleanupEntry[] = known
            .filter((asset) => !existing.has(asset.id))
            .map(entryFromAsset);
          const placeholders: CleanupEntry[] = unknown
            .filter((id) => !existing.has(id))
            .map((id) => ({
              asset_id: id,
              added_at: String(Math.floor(Date.now() / 1000)),
              source: "space",
              path: id,
              day: null,
              taken_at: null,
              kind: null,
              size: null,
            }));
          const total = [...added, ...placeholders];
          if (!total.length) return base;
          return {
            items: [...total, ...base.items],
            count: base.count + total.length,
            bytes: base.bytes + added.reduce((sum, item) => sum + (item.size ?? 0), 0),
          };
        }
        const drop = new Set(unique);
        const next = base.items.filter((item) => !drop.has(item.asset_id));
        if (next.length === base.items.length) return base;
        return {
          items: next,
          count: base.count - (base.items.length - next.length),
          bytes: next.reduce((sum, item) => sum + (item.size ?? 0), 0),
        };
      });
      setBusy(true);
      // 后端单次最多 2000 个 id：大组/整页默认勾选时分批，避免静默截断。
      const chunks: string[][] = [];
      for (let start = 0; start < unique.length; start += 2000) {
        chunks.push(unique.slice(start, start + 2000));
      }
      chunks
        .reduce<Promise<{ changed?: number; count: number; bytes: number }>>(
          (pending, chunk) =>
            pending.then((last) =>
              (add ? cleanupAdd(chunk) : cleanupRemove(chunk)).then((next) => ({
                ...next,
                changed: (last.changed ?? 0) + (next.changed ?? 0),
              })),
            ),
          Promise.resolve({ changed: 0, count: 0, bytes: 0 }),
        )
        .then((change) => {
          if (add && unique.length === 1) {
            onToast("已加入待清理", { kind: "action", action: { label: "移出", run: () => applyQueueRef.current(unique, false) } });
          }
          setQueue((previous) =>
            previous ? { ...previous, count: change.count, bytes: change.bytes } : previous,
          );
          if (known.length !== unique.length) void refreshQueue();
          void refreshStats();
        })
        .catch((reason) => {
          setQueue(snapshot);
          onError((add ? "加入待清理失败：" : "移出待清理失败：") + String(reason));
        })
        .finally(() => setBusy(false));
    },
    [onToast, queue, refreshQueue, refreshStats, rowById],
  );

  /** 卡片消失：底部升起一团 accent 柔光把它带走，1400ms。 */
  const playVanish = useCallback((rect: DOMRect, thumb: string) => {
    const root = flyRootRef.current;
    if (!root) return;
    const el = document.createElement("div");
    el.className = "space-fly";
    const box = root.getBoundingClientRect();
    el.style.left = `${rect.left - box.left}px`;
    el.style.top = `${rect.top - box.top}px`;
    el.style.width = `${rect.width}px`;
    el.style.height = `${rect.height}px`;
    const img = document.createElement("img");
    img.src = assetSrc(thumb);
    img.alt = "";
    el.appendChild(img);
    const glow = document.createElement("span");
    glow.className = "space-fly-glow";
    el.appendChild(glow);
    root.appendChild(el);
    const done = () => el.remove();
    if (reducedMotion() || flyingRef.current >= 3) {
      // 减少动效 / 同时超过 3 张：直接淡出，不排队。
      el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 150, fill: "forwards" }).finished.then(done, done);
      return;
    }
    flyingRef.current += 1;
    glow.animate(
      [
        { opacity: 0, transform: "translateY(40%) scaleY(0.4)" },
        { opacity: 0.2, transform: "translateY(0) scaleY(1)", offset: 0.45 },
        { opacity: 0.32, transform: "translateY(-12%) scaleY(1.08)", offset: 0.7 },
        { opacity: 0, transform: "translateY(-60%) scaleY(1.2)" },
      ],
      { duration: 1400, easing: "cubic-bezier(.25,.1,.25,1)", fill: "forwards" },
    );
    el.animate(
      [
        { opacity: 1, transform: "none" },
        { opacity: 0.92, transform: "none", offset: 0.55 },
        { opacity: 0, transform: "translateY(-6px) scale(0.98)" },
      ],
      { duration: 1400, easing: "cubic-bezier(.25,.1,.25,1)", fill: "forwards" },
    ).finished.then(done, done).finally(() => {
      flyingRef.current = Math.max(0, flyingRef.current - 1);
    });
  }, []);

  applyQueueRef.current = applyQueue;

  const toggleAssets = useCallback(
    (assets: Asset[], add: boolean) => {
      if (!assets.length) return;
      applyQueue(assets.map((asset) => asset.id), add);
    },
    [applyQueue],
  );

  /** 某张图所在重复组的成员（含 keeper），带缓存。 */
  const groupIdsOf = useCallback(async (assetId: string) => {
    const cached = Object.entries(groupIdsRef.current).find(([, ids]) => ids.includes(assetId));
    if (cached) return cached[1];
    let offset = 0;
    for (;;) {
      const page = await spaceGroups("dup", { limit: 500, offset });
      if (!page.groups.length) break;
      for (const group of page.groups) {
        if (groupIdsRef.current[group.key]) continue;
        const ids = (await spaceGroups("dup", { group: group.key })).groups[0]?.ids ?? [];
        groupIdsRef.current[group.key] = ids;
        if (ids.includes(assetId)) return ids;
      }
      offset += page.groups.length;
    }
    return [] as string[];
  }, []);

  /** 分组视图：按组对象直接切换，不用再去反查成员。 */
  const toggleDupGroup = useCallback(
    (group: DupGroupPageGroup) => {
      const keeper = group.keeper ?? group.members.find((member) => member.is_keeper)?.id ?? null;
      const candidates = group.members
        .map((member) => member.id)
        .filter((id) => id !== keeper);
      if (!candidates.length) return;
      const add = candidates.some((id) => !queueIds.has(id));
      applyQueue(add ? candidates.filter((id) => !queueIds.has(id)) : candidates, add);
    },
    [applyQueue, queueIds],
  );

  /** 重复图：点任意一张 = 整组切换，keeper 永远不进待清理。 */
  const toggleDupByAsset = useCallback(
    async (assetId: string) => {
      try {
        const ids = await groupIdsOf(assetId);
        const keeper = ids.find((id) => rowById.get(id)?.keeper) ?? null;
        const candidates = ids.filter((id) => id !== keeper);
        if (!candidates.length) return;
        const add = candidates.some((id) => !queueIds.has(id));
        applyQueue(add ? candidates.filter((id) => !queueIds.has(id)) : candidates, add);
      } catch (reason) {
        onError("读取这一组失败：" + String(reason));
      }
    },
    [applyQueue, groupIdsOf, onToast, queueIds, rowById],
  );

  const handleCardClick = useCallback(
    (asset: Asset, event: React.MouseEvent) => {
      const inQueue = queueIds.has(asset.id);
      setFocusId(asset.id);

      if (event.shiftKey && anchorRef.current) {
        const from = rows.findIndex((item) => item.id === anchorRef.current);
        const to = rows.findIndex((item) => item.id === asset.id);
        if (from >= 0 && to >= 0) {
          const [start, end] = from <= to ? [from, to] : [to, from];
          toggleAssets(rows.slice(start, end + 1), !inQueue);
          return;
        }
      }

      if (view === "dup") {
        void toggleDupByAsset(asset.id);
        anchorRef.current = asset.id;
        return;
      }

      if (!inQueue) {
        // 离开网格前先量位置、留缩略图：替身层挂在滚动容器那一级。
        const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
        vanishRef.current += 1;
        playVanish(rect, asset.thumb);
        flipPending.current = true;
        window.setTimeout(() => {
          vanishRef.current = Math.max(0, vanishRef.current - 1);
        }, 1400);
      }
      toggleAssets([asset], !inQueue);
      anchorRef.current = asset.id;
    },
    [playVanish, queueIds, rows, toggleAssets, toggleDupByAsset, view],
  );

  // 键盘：方向键移焦点，空格/回车切换待清理。
  const moveFocus = useCallback(
    (delta: number, extend: boolean) => {
      if (!rows.length) return;
      const current = focusId ? rows.findIndex((asset) => asset.id === focusId) : -1;
      const next = Math.max(0, Math.min(rows.length - 1, (current < 0 ? 0 : current) + delta));
      const asset = rows[next];
      if (!asset) return;
      setFocusId(asset.id);
      if (extend) toggleAssets([asset], !queueIds.has(asset.id));
      requestAnimationFrame(() => {
        gridRef.current
          ?.querySelector<HTMLElement>(`[data-grid-id="${asset.id}"]`)
          ?.scrollIntoView({ block: "nearest" });
      });
    },
    [focusId, queueIds, rows, toggleAssets],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", " ", "Enter"].includes(event.key)) return;
      event.preventDefault();
      if (event.key === "ArrowLeft") moveFocus(-1, event.shiftKey);
      else if (event.key === "ArrowRight") moveFocus(1, event.shiftKey);
      else if (event.key === "ArrowUp") moveFocus(-columns, event.shiftKey);
      else if (event.key === "ArrowDown") moveFocus(columns, event.shiftKey);
      else {
        const asset = rows.find((item) => item.id === focusId) ?? rows[0];
        if (asset) {
          setFocusId(asset.id);
          if (view === "dup") void toggleDupByAsset(asset.id);
          else toggleAssets([asset], !queueIds.has(asset.id));
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [columns, focusId, moveFocus, queueIds, rows, toggleAssets, toggleDupByAsset, view]);

  const addAllDup = useCallback(async () => {
    if (allBusy) return;
    setAllBusy(true);
    setConfirmAll(false);
    onProgress("正在把重复项加入待清理…");
    try {
      const change = await cleanupAddAllDup();
      await refreshQueue();
      void refreshStats();
      onProgressDone({
        text: "已加入 " + change.changed + " 个重复项",
        action: { label: "查看清单", run: onOpenQueue },
      });
    } catch (reason) {
      onError("全部加入失败：" + String(reason));
    } finally {
      setAllBusy(false);
    }
  }, [allBusy, onToast, refreshQueue, refreshStats]);

  const removeAll = useCallback(async () => {
    const ids = (queue?.items ?? []).map((item) => item.asset_id);
    if (!ids.length) return;
    const previous = queue;
    setQueue({ items: [], count: 0, bytes: 0 });
    setBusy(true);
    try {
      // 后端单次最多 2000 个：重复图一次加入几千条时必须分批。
      let change = { changed: 0, count: ids.length, bytes: 0 };
      for (let start = 0; start < ids.length; start += 2000) {
        change = await cleanupRemove(ids.slice(start, start + 2000));
      }
      setQueue({ items: [], count: change.count, bytes: change.bytes });
      void refreshStats();
    } catch (reason) {
      setQueue(previous);
      onError("移出待清理失败：" + String(reason));
    } finally {
      setBusy(false);
    }
  }, [busy, onToast, queue, refreshStats]);

  // 网格 FLIP：可见卡片变化前记位置，变化后只补间 transform（不动高度）。
  const flipPending = useRef(false);
  useLayoutEffect(() => {
    const container = gridRef.current;
    if (!container) return;
    const next = new Map<string, DOMRect>();
    container.querySelectorAll<HTMLElement>("[data-grid-id]").forEach((el) => {
      next.set(el.dataset.gridId ?? "", el.getBoundingClientRect());
    });
    const previous = prevRects.current;
    prevRects.current = next;
    if (!flipPending.current || previous.size === 0) return;
    flipPending.current = false;
    if (reducedMotion()) return;
    const delay = vanishRef.current > 0 ? 640 : 0;
    next.forEach((rect, id) => {
      const prev = previous.get(id);
      if (!prev) return;
      const dx = prev.left - rect.left;
      const dy = prev.top - rect.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      const el = container.querySelector<HTMLElement>(`[data-grid-id="${id}"]`);
      if (!el) return;
      const frames: Keyframe[] = [];
      for (let step = 0; step <= 16; step += 1) {
        const t = step / 16;
        const progress = 1 - Math.exp(-7 * t) * Math.cos(6 * t);
        frames.push({
          transform: `translate(${(dx * (1 - progress)).toFixed(2)}px, ${(dy * (1 - progress)).toFixed(2)}px)`,
          offset: t,
        });
      }
      frames.push({ transform: "translate(0, 0)", offset: 1 });
      el.animate(frames, { duration: 520, delay, easing: "linear", fill: "backwards" });
    });
  }, [visibleRows, columns]);

  const rowVirtualizer = useVirtualizer({
    count: Math.ceil(visibleRows.length / columns),
    getScrollElement: () => scrollRef.current,
    estimateSize: () => Math.round(((gridWidth - GAP * (columns - 1)) / columns) * 0.625) + 8 + GAP,
    overscan: 2,
  });

  const cardWidth = gridWidth > 0 ? (gridWidth - GAP * (columns - 1)) / columns : CARD_MIN_WIDTH;
  const cardHeight = Math.round(cardWidth * 0.625) + 8;
  const queueTotal = queue?.count ?? 0;
  const queueBytes = queue?.bytes ?? 0;
  const dupStat = views?.dup;

  return (
    <div className={clsx("space-view", queueOpen && "with-drawer")}>
      <div className="space-topbar">
        <div className="space-view-pills" role="tablist" aria-label="清理视角">
          {VIEWS.map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={view === item.key}
              className={clsx("space-pill", view === item.key && "active")}
              title={item.hint}
              onClick={() => {
                if (item.key === view) return;
                setView(item.key);
              }}
            >
              <span>{item.label}</span>
            </button>
          ))}
        </div>
        <div className="space-topbar-right">
          <div className="space-filter">
            <Search size={11} strokeWidth={1.8} />
            <input
              value={filterInput}
              onChange={(event) => {
                const value = event.target.value;
                setFilterInput(value);
                window.clearTimeout(filterTimer.current);
                filterTimer.current = window.setTimeout(() => setPathFilter(value.trim()), 150);
              }}
              placeholder="筛选路径"
              aria-label="按路径筛选文件网格"
            />
            {filterInput && (
              <button
                type="button"
                onClick={() => {
                  setFilterInput("");
                  setPathFilter("");
                }}
                aria-label="清除路径筛选"
              >
                <X size={11} strokeWidth={2} />
              </button>
            )}
          </div>
          <button
            type="button"
            className={clsx("space-info", infoOpen && "on")}
            onClick={() => setInfoOpen((open) => !open)}
            aria-label="口径与统计"
            aria-expanded={infoOpen}
          >
            <Info size={12} strokeWidth={1.8} />
          </button>
        </div>
      </div>

      {infoOpen && (
        <p className="space-info-pop">
          {summaryLine}
          {views?.[view]?.rule ? ` · ${views[view]?.rule}` : ""}
        </p>
      )}

      {view === "dup" && dupStat?.ready && groupsTotal > 0 && (
        <div className="space-bulk-dup">
          <span className="space-bulk-copy">
            发现 {groupsTotal.toLocaleString()} 组重复 · 可回收 {statBytes(dupStat.reclaim ?? 0)}
          </span>
          <button
            type="button"
            className="space-bulk-all"
            onClick={() => setConfirmAll(true)}
            disabled={allBusy}
          >
            {allBusy ? "正在加入…" : "自动保留每组最佳，其余加入待清理"}
          </button>
          {confirmAll && (
            <span className="space-confirm">
              <span>keeper 不会加入。</span>
              <button type="button" className="ghost-button" onClick={() => setConfirmAll(false)}>
                取消
              </button>
              <button type="button" className="danger-btn" onClick={() => void addAllDup()}>
                确认
              </button>
            </span>
          )}
        </div>
      )}

      {view === "screenshot" && groups.length > 0 && (
        <div className="space-group-chips">
          {groups.map((group) => {
            const ids = group.ids ?? [];
            const candidates = ids.filter((id) => id !== group.keep);
            const inQueue = candidates.filter((id) => queueIds.has(id)).length;
            return (
              <button
                key={group.key}
                type="button"
                className={clsx("space-group-chip", inQueue === candidates.length && candidates.length > 0 && "on")}
                onClick={() => {
                  const add = candidates.some((id) => !queueIds.has(id));
                  applyQueue(add ? candidates.filter((id) => !queueIds.has(id)) : candidates, add);
                }}
              >
                <strong>{group.label}</strong>
                <span>{ids.length} 张</span>
              </button>
            );
          })}
        </div>
      )}

      <div className="space-grid" ref={scrollRef} role="grid" aria-label="文件缩略图" aria-multiselectable="true">
        {/* 替身层挂在这里：卡片从列表里移除后它还在，且不参与网格布局。 */}
        <div ref={flyRootRef} className="space-fly-root" aria-hidden="true" />
        {view === "dup" ? (
          <DupGroupBoard
            groups={dupGroups}
            queued={queueIds}
            onToggleGroup={toggleDupGroup}
            onToggleCandidates={applyQueue}
            loadingMore={dupLoadingMore}
            hasMore={dupGroups.length < dupTotalGroups}
            onLoadMore={loadMoreDup}
          />
        ) : (
          <div
            ref={gridRef}
            className="space-grid-inner"
            style={{ height: Math.max(rowVirtualizer.getTotalSize(), cardHeight) + "px" }}
          >
            {gridWidth > 0 &&
              rowVirtualizer.getVirtualItems().map((virtualRow) => {
                const items = visibleRows.slice(virtualRow.index * columns, virtualRow.index * columns + columns);
                return (
                  <div
                    key={virtualRow.key}
                    className="space-grid-row"
                    style={{
                      height: cardHeight + "px",
                      transform: "translateY(" + virtualRow.start + "px)",
                      gridTemplateColumns: "repeat(" + columns + ", minmax(0, 1fr))",
                      gap: GAP + "px",
                    }}
                  >
                    {items.map((asset) => (
                      <SpaceCard
                        key={asset.id}
                        asset={asset}
                        inQueue={queueIds.has(asset.id)}
                        focused={focusId === asset.id}
                        dupCount={0}
                        keeper={false}
                        onToggle={handleCardClick}
                        onOpen={() => onOpenDetail(entryFromAsset(asset), rows)}
                      />
                    ))}
                  </div>
                );
              })}
            {loading && rows.length === 0 && (
              <div className="space-grid-loading">
                <LoaderCircle size={16} className="spin" />
                <span>正在读取…</span>
              </div>
            )}
          </div>
        )}
        <div ref={sentinelRef} className="space-sentinel">
          {view === "dup" ? (
            dupLoadingMore ? (
              <span><LoaderCircle size={12} className="spin" /> 载入中…</span>
            ) : dupGroups.length < dupTotalGroups ? (
              <span>继续下滑</span>
            ) : dupGroups.length > 0 ? (
              <span>已到底</span>
            ) : null
          ) : loadingMore ? (
            <span><LoaderCircle size={12} className="spin" /> 载入中…</span>
          ) : hasMore ? (
            <span>继续下滑</span>
          ) : rows.length > 0 ? (
            <span>已到底</span>
          ) : null}
        </div>
        {error && <div className="space-empty">读取失败：{error}</div>}
        {!loading && !error && rows.length === 0 && view !== "dup" && (
          <div className="space-empty">
            <ImageOff size={20} strokeWidth={1.5} />
            <strong>{pathFilter ? "没有匹配的文件" : "这里没有文件"}</strong>
          </div>
        )}
        {view === "dup" && !dupLoadingMore && dupGroups.length === 0 && (
          <div className="space-empty">
            {dupStat?.ready === false ? (
              <>
                <LoaderCircle size={20} strokeWidth={1.5} className={computing ? "spin" : undefined} />
                <strong>{computing ? "正在计算指纹…" : "指纹还没算"}</strong>
                <button type="button" className="primary-btn" onClick={() => void computeDup()} disabled={computing}>
                  {computing ? "计算中…" : "立即计算"}
                </button>
              </>
            ) : (
              <>
                <ImageOff size={20} strokeWidth={1.5} />
                <strong>没有重复组</strong>
              </>
            )}
          </div>
        )}
      </div>

      {queueTotal > 0 && (
        <div className="space-settlement">
          <strong>{queueTotal} 个 · {statBytes(queueBytes)}</strong>
          <button type="button" className="space-link" onClick={() => setQueueOpen(true)}>
            查看清单
          </button>
          <button
            type="button"
            className="space-danger"
            disabled={busy}
            onClick={(event) => {
              onClean(
                (queue?.items ?? []).map((item) => item.asset_id),
                event.currentTarget.getBoundingClientRect(),
              );
            }}
          >
            <Trash2 size={13} strokeWidth={2} /> 清理
          </button>
        </div>
      )}

      {queueOpen && queueTotal > 0 && (
        <aside className="space-queue" role="dialog" aria-modal="false" aria-label="待清理清单">
          <div className="space-pane-head">
            <div>
              <h2>待清理</h2>
              <p>{queueTotal} 个</p>
            </div>
            <div className="space-queue-tools">
              <button type="button" className="space-link" disabled={busy} onClick={() => void removeAll()}>
                <Undo2 size={12} strokeWidth={1.9} /> 全部移出
              </button>
              <button type="button" className="space-info" onClick={() => setQueueOpen(false)} aria-label="关闭清单">
                <X size={13} strokeWidth={2} />
              </button>
            </div>
          </div>
          <div className="space-queue-list" role="list">
            {(queue?.items ?? []).map((entry) => (
              <div key={entry.asset_id} className="space-queue-item">
                <button
                  type="button"
                  className="space-queue-main"
                  onClick={() => {
                    setFocusId(entry.asset_id);
                    onOpenDetail(entry, rows);
                  }}
                  title={entry.path}
                >
                  <span className="space-queue-name">{entry.path.split("/").pop()}</span>
                  <span className="space-queue-meta">{formatBytes(entry.size ?? 0)}</span>
                </button>
                <button
                  type="button"
                  className="space-queue-remove"
                  onClick={() => applyQueue([entry.asset_id], false)}
                  disabled={busy}
                  aria-label="移出待清理"
                >
                  <X size={13} strokeWidth={2} />
                </button>
              </div>
            ))}
          </div>
        </aside>
      )}
    </div>
  );
}

/** 面板头的唯一一句统计：每个数字只在这里出现一次。 */
function currentStatLine(views: SpaceViews | null, view: SpaceViewKey, loading: boolean): string {
  const stat = views?.[view];
  if (!stat) return loading ? "读取中…" : "";
  if (view === "dup") {
    return `${stat.count.toLocaleString()} 张`;
  }
  return `${stat.count.toLocaleString()} 个 · ${statBytes(stat.bytes)}`;
}

function SpaceCard({
  asset,
  inQueue,
  focused,
  dupCount,
  keeper = false,
  onToggle,
  onOpen,
}: {
  asset: Asset;
  inQueue: boolean;
  focused: boolean;
  dupCount: number;
  keeper?: boolean;
  onToggle: (asset: Asset, event: React.MouseEvent) => void;
  onOpen: () => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [useOriginal, setUseOriginal] = useState(false);

  useEffect(() => {
    // 只跟着文件本身变；勾选状态变化不重载缩略图，滚动时不会闪。
    setLoaded(false);
    setFailed(false);
    setUseOriginal(false);
  }, [asset.id, asset.thumb]);

  const isVideo = asset.kind === "video";
  const src = assetSrc(useOriginal ? asset.original : asset.thumb);

  return (
    <button
      type="button"
      className={clsx("space-card", inQueue && "queued", focused && "focused")}
      data-grid-id={asset.id}
      title={asset.path}
      aria-pressed={inQueue}
      aria-label={(isVideo ? "视频" : "照片") + " " + asset.path.split("/").pop() + " · " + formatBytes(asset.size ?? 0)}
      onClick={(event) => onToggle(asset, event)}
      onDoubleClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onOpen();
      }}
    >
      <span className="space-card-frame">
        {!failed && (
          <img
            src={src}
            alt=""
            draggable={false}
            loading="lazy"
            decoding="async"
            className={clsx("space-card-img", loaded && "ready")}
            onLoad={() => setLoaded(true)}
            onError={() => {
              // 缩略图缺失就退回原图；原图也解不了才显示占位块，不留裂图。
              if (!useOriginal && asset.original && asset.original !== asset.thumb) {
                setUseOriginal(true);
                return;
              }
              setFailed(true);
            }}
          />
        )}
        {!loaded && !failed && <span className="space-card-skeleton" aria-hidden="true" />}
        {failed && (
          <span className="space-card-placeholder">
            <ImageOff size={18} strokeWidth={1.5} />
            <em>{formatBytes(asset.size ?? 0)}</em>
          </span>
        )}
        {isVideo && (
          <span className="space-card-play" aria-hidden="true">
            <Play size={11} fill="currentColor" strokeWidth={0} />
          </span>
        )}
        {keeper ? (
          <span className="space-card-keeper">保留</span>
        ) : (
          dupCount > 1 && <span className="space-card-dup">×{dupCount}</span>
        )}
        <span className="space-card-check" aria-hidden="true">
          {inQueue && <Check size={11} strokeWidth={2.6} />}
        </span>
        <span className="space-card-size">{formatBytes(asset.size ?? 0)}</span>
      </span>
    </button>
  );
}

