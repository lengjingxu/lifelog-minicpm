import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import clsx from "clsx";
import {
  Check,
  ExternalLink,
  Film,
  Image as ImageIcon,
  ImageOff,
  Info,
  LoaderCircle,
  Maximize2,
  Play,
  Plus,
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
  openExternal as openExternalPath,
  queryAssets,
  revealInFinder,
  spaceGroups,
  spaceVersions,
  spaceViews,
  type Asset,
  type CleanupEntry,
  type CleanupList,
  type SpaceGroup,
  type SpaceViewKey,
  type SpaceViews,
} from "../api";
import { GAP, formatBytes, timeLabel } from "../utils";

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

function kindText(entry: CleanupEntry): string {
  if (entry.kind === "video") return "视频";
  if (entry.kind === "live" || entry.kind === "live_photo") return "实况";
  return "照片";
}

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
  onToast: (text: string, action?: { label: string; run: () => void }) => void;
  /** 真实清理成功后 App 会加一，用来重新拉清单和统计。 */
  dataVersion: number;
  /** 已载入的这一页同步给 App，预览翻页就在这一页里走。 */
  onRows: (rows: Asset[]) => void;
};

export function SpaceView({ onOpenDetail, onClean, onToast, dataVersion, onRows }: Props) {
  const [view, setView] = useState<SpaceViewKey>("large");
  const [views, setViews] = useState<SpaceViews | null>(null);
  const [groups, setGroups] = useState<SpaceGroup[]>([]);
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
  const [lastClean, setLastClean] = useState<{ count: number; bytes: number } | null>(null);
  const [computing, setComputing] = useState(false);
  const [allBusy, setAllBusy] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
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

  const queueIds = useMemo(() => new Set((queue?.items ?? []).map((item) => item.asset_id)), [queue]);
  const rowById = useMemo(() => new Map(rows.map((asset) => [asset.id, asset])), [rows]);
  const columns = Math.max(2, Math.min(6, Math.floor((gridWidth + GAP) / (CARD_MIN_WIDTH + GAP))));

  // 一屏只出现一次的数字：面板头用这一句，胶囊只留名字。
  const summaryLine = currentStatLine(views, view, loading);

  const refreshQueue = useCallback(async () => {
    try {
      setQueue(await cleanupList());
    } catch (reason) {
      onToast("读取待清理清单失败：" + String(reason));
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
    spaceGroups(view, view === "dup" ? { limit: 1 } : {})
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
      onToast("计算指纹失败：" + String(reason));
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

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMore();
      },
      { root: scrollRef.current, rootMargin: "600px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [loadMore]);

  // 乐观更新：点一下立刻变勾；请求失败回滚。
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
          setQueue((previous) =>
            previous ? { ...previous, count: change.count, bytes: change.bytes } : previous,
          );
          if (known.length !== unique.length) void refreshQueue();
          void refreshStats();
        })
        .catch((reason) => {
          setQueue(snapshot);
          onToast((add ? "加入待清理失败：" : "移出待清理失败：") + String(reason));
        })
        .finally(() => setBusy(false));
    },
    [onToast, queue, refreshQueue, refreshStats, rowById],
  );

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
        onToast("读取这一组失败：" + String(reason));
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

      toggleAssets([asset], !inQueue);
      anchorRef.current = asset.id;
    },
    [queueIds, rows, toggleAssets, toggleDupByAsset, view],
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
    try {
      const change = await cleanupAddAllDup();
      await refreshQueue();
      void refreshStats();
      onToast("已加入 " + change.changed + " 个重复项（keeper 未加入）");
    } catch (reason) {
      onToast("全部加入失败：" + String(reason));
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
      onToast("移出待清理失败：" + String(reason));
    } finally {
      setBusy(false);
    }
  }, [busy, onToast, queue, refreshStats]);

  const rowVirtualizer = useVirtualizer({
    count: Math.ceil(rows.length / columns),
    getScrollElement: () => scrollRef.current,
    estimateSize: () => Math.round(((gridWidth - GAP * (columns - 1)) / columns) * 0.625) + 8 + GAP,
    overscan: 2,
  });

  const cardWidth = gridWidth > 0 ? (gridWidth - GAP * (columns - 1)) / columns : CARD_MIN_WIDTH;
  const cardHeight = Math.round(cardWidth * 0.625) + 8;
  const queueTotal = queue?.count ?? 0;
  const queueBytes = queue?.bytes ?? 0;
  const focused = focusedId(rows, queue, focusId);
  const dupStat = views?.dup;

  return (
    <div className="space-view">
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

      <div className="space-columns">
        {/* 左：网格 */}
        <section className="space-pane space-rank" aria-label="文件网格">
          <div className="space-pane-head">
            <div className="space-rank-title">
              <h2>{VIEWS.find((item) => item.key === view)?.label}</h2>
              <p>{summaryLine}</p>
            </div>
            <div className="space-rank-tools">
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
                aria-label="口径说明"
                aria-expanded={infoOpen}
              >
                <Info size={12} strokeWidth={1.8} />
              </button>
            </div>
          </div>

          {infoOpen && <p className="space-info-pop">{views?.[view]?.rule ?? "按体积与指纹筛选"}</p>}

          {view === "dup" && dupStat?.ready && groupsTotal > 0 && (
            <div className="space-bulk-dup">
              <span className="space-bulk-copy">
                {groupsTotal.toLocaleString()} 组重复 · 可回收 {statBytes(dupStat.reclaim ?? 0)}
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
                <div className="space-confirm">
                  <span>keeper 不会加入。</span>
                  <button type="button" className="ghost-button" onClick={() => setConfirmAll(false)}>
                    取消
                  </button>
                  <button type="button" className="danger-btn" onClick={() => void addAllDup()}>
                    确认
                  </button>
                </div>
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
            <div
              ref={gridRef}
              className="space-grid-inner"
              style={{ height: Math.max(rowVirtualizer.getTotalSize(), cardHeight) + "px" }}
            >
              {gridWidth > 0 &&
                rowVirtualizer.getVirtualItems().map((virtualRow) => {
                  const items = rows.slice(virtualRow.index * columns, virtualRow.index * columns + columns);
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
                          dupCount={view === "dup" ? asset.dup_count ?? 0 : 0}
                          keeper={view === "dup" && asset.keeper === true}
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
            <div ref={sentinelRef} className="space-sentinel">
              {loadingMore ? (
                <span><LoaderCircle size={12} className="spin" /> 载入中…</span>
              ) : hasMore ? (
                <span>继续下滑</span>
              ) : rows.length > 0 ? (
                <span>已到底</span>
              ) : null}
            </div>
            {error && <div className="space-empty">读取失败：{error}</div>}
            {!loading && !error && rows.length === 0 && (
              <div className="space-empty">
                {view === "dup" && dupStat?.ready === false ? (
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
                    <strong>{pathFilter ? "没有匹配的文件" : "这里没有文件"}</strong>
                  </>
                )}
              </div>
            )}
          </div>
        </section>

        {/* 中：预览 */}
        <section className="space-pane space-preview" aria-label="预览">
          <div className="space-pane-head">
            <div>
              <h2>预览</h2>
              <p>{focused ? kindText(focused) + " · " + formatBytes(focused.size ?? 0) : ""}</p>
            </div>
          </div>
          {focused ? (
            <PreviewBody
              entry={focused}
              inQueue={queueIds.has(focused.asset_id)}
              busy={busy}
              onOpenDetail={() => onOpenDetail(focused, rows)}
              onReveal={() => {
                void revealInFinder(focused.path).catch(() => onToast("在 Finder 中显示失败"));
              }}
              onAdd={() => applyQueue([focused.asset_id], true)}
              onRemove={() => applyQueue([focused.asset_id], false)}
            />
          ) : (
            <div className="space-preview-empty">
              <ImageIcon size={26} strokeWidth={1.4} />
              <span>点一个格子预览</span>
            </div>
          )}
        </section>

        {/* 右：待清理 */}
        <section className="space-pane space-queue" aria-label="待清理">
          <div className="space-pane-head">
            <div>
              <h2>待清理</h2>
            </div>
            {queueTotal > 0 && (
              <button type="button" className="space-link" disabled={busy} onClick={() => void removeAll()}>
                <Undo2 size={12} strokeWidth={1.9} /> 全部移出
              </button>
            )}
          </div>

          <div className="space-queue-list" role="list">
            {(queue?.items ?? []).length === 0 ? (
              <div className="space-queue-empty">
                <span>点一下左侧格子加入</span>
              </div>
            ) : (
              (queue?.items ?? []).map((entry) => (
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
              ))
            )}
          </div>

          <div className="space-settlement">
            <div className="space-settlement-copy">
              <strong>{queueTotal} 个 · {statBytes(queueBytes)}</strong>
              {lastClean && queueTotal === 0 && (
                <em className="space-settlement-last">
                  上次清理 {lastClean.count} 个 · {statBytes(lastClean.bytes)}
                </em>
              )}
              <span>原图进废纸篓，可从那里找回</span>
            </div>
            <button
              type="button"
              className="space-danger"
              disabled={queueTotal === 0 || busy}
              onClick={(event) => {
                setLastClean({ count: queueTotal, bytes: queueBytes });
                onClean(
                  (queue?.items ?? []).map((item) => item.asset_id),
                  event.currentTarget.getBoundingClientRect(),
                );
              }}
            >
              <Trash2 size={13} strokeWidth={2} /> 清理
            </button>
          </div>
        </section>
      </div>
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

function focusedId(rows: Asset[], queue: CleanupList | null, id: string | null): CleanupEntry | null {
  if (!id) return null;
  const asset = rows.find((item) => item.id === id);
  if (asset) return entryFromAsset(asset);
  return queue?.items.find((entry) => entry.asset_id === id) ?? null;
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

function PreviewBody({
  entry,
  inQueue,
  onOpenDetail,
  onReveal,
  onAdd,
  onRemove,
  busy,
}: {
  entry: CleanupEntry;
  inQueue: boolean;
  onOpenDetail: () => void;
  onReveal: () => void;
  onAdd: () => void;
  onRemove: () => void;
  busy: boolean;
}) {
  const [useOriginal, setUseOriginal] = useState(false);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  // 视频先走助手的 loading，再走 error；两者都不来时用超时兜底，面板不能一直空着。
  const [mediaTimeout, setMediaTimeout] = useState(false);
  const [externalError, setExternalError] = useState<string | null>(null);
  const isVideo = entry.kind === "video";

  useEffect(() => {
    // 换文件时把播放器/图片状态全部重置，避免上一段视频的错误落在下一张上。
    setUseOriginal(false);
    setReady(false);
    setFailed(false);
    setMediaTimeout(false);
    setExternalError(null);
  }, [entry.asset_id]);

  useEffect(() => {
    if (ready || failed) return;
    const timer = window.setTimeout(() => setMediaTimeout(true), isVideo ? 8000 : 4000);
    return () => window.clearTimeout(timer);
  }, [entry.asset_id, failed, isVideo, ready]);

  const broken = failed || mediaTimeout;

  const thumb = assetSrc(entry.thumb || "");
  const original = assetSrc(entry.path);

  const openExternal = () => {
    setExternalError(null);
    openExternalPath(entry.path).catch((reason: unknown) => {
      setExternalError("无法交给系统播放器：" + String(reason));
    });
  };

  return (
    <div className="space-preview-body">
      <div
        className={clsx("space-preview-stage", isVideo && "video", broken && "failed")}
        onDoubleClick={onOpenDetail}
        title="双击打开大图 / 播放"
      >
        {isVideo ? (
          !broken && (
            <video
              key={entry.asset_id}
              className={clsx("space-video", ready && "ready")}
              src={original}
              poster={thumb || undefined}
              controls
              playsInline
              preload="metadata"
              onLoadedMetadata={() => setReady(true)}
              onCanPlay={() => setReady(true)}
              onError={() => setFailed(true)}
            />
          )
        ) : (
          !broken && (
            <img
              key={entry.asset_id + (useOriginal ? "-original" : "-thumb")}
              src={useOriginal ? original : thumb || original}
              alt={entry.path.split("/").pop() ?? ""}
              draggable={false}
              className={clsx(ready && "ready")}
              onLoad={() => setReady(true)}
              onError={() => {
                // 缩略图缺失就退回原图；原图也解不了才显示兜底。
                if (!useOriginal) {
                  setUseOriginal(true);
                  return;
                }
                setFailed(true);
              }}
            />
          )
        )}
        {!ready && !broken && <span className="skeleton" aria-hidden="true" />}
        {broken && (
          <div className="space-preview-fallback">
            <Film size={22} strokeWidth={1.4} />
            <strong>这个格式系统解不了</strong>
            <span>{entry.path.split("/").pop()}</span>
            <button type="button" className="space-fallback-open" onClick={openExternal}>
              <ExternalLink size={12} strokeWidth={1.8} /> 在外部播放器打开
            </button>
            {externalError && <em className="space-fallback-error">{externalError}</em>}
          </div>
        )}
      </div>

      <div className="space-preview-info">
        <strong title={entry.path}>{entry.path.split("/").pop()}</strong>
        <span>{kindText(entry)} · {statBytes(entry.size ?? 0)}</span>
        <span>{timeLabel(entry.taken_at)}</span>
        <span className="space-preview-path" title={entry.path}>{entry.path}</span>
      </div>

      <div className="space-preview-actions">
        {inQueue ? (
          <button type="button" className="ghost-button" onClick={onRemove} disabled={busy}>
            <Undo2 size={12} strokeWidth={1.9} /> 移出待清理
          </button>
        ) : (
          <button type="button" className="ghost-button" onClick={onAdd} disabled={busy}>
            <Plus size={12} strokeWidth={2} /> 加入待清理
          </button>
        )}
        <button type="button" className="ghost-button" onClick={onOpenDetail}>
          <Maximize2 size={12} strokeWidth={1.8} /> 大图
        </button>
        <button type="button" className="ghost-button" onClick={onReveal}>
          在 Finder 中显示
        </button>
        <button type="button" className="ghost-button" onClick={openExternal}>
          <ExternalLink size={12} strokeWidth={1.8} /> 外部播放器
        </button>
      </div>
    </div>
  );
}

