import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import clsx from "clsx";
import {
  Check,
  CheckSquare,
  ExternalLink,
  Film,
  Image as ImageIcon,
  ImageOff,
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

// 五个视角。同一时间只有一个生效；口径写在这里，界面上也能看到。
const VIEWS: SpaceViewItem[] = [
  { key: "large", label: "全部大文件", hint: "按文件体积从大到小" },
  { key: "dup", label: "重复图", hint: "同 size 同 kind 的图片粗筛" },
  { key: "screenshot", label: "屏幕截图", hint: "路径 + scene/tags 两层筛选" },
  { key: "video", label: "视频", hint: "kind = video" },
  { key: "photo", label: "照片", hint: "kind = image" },
];

function kindText(entry: CleanupEntry): string {
  if (entry.kind === "video") return "视频";
  if (entry.kind === "live" || entry.kind === "live_photo") return "实况";
  return "照片";
}

/** 空间页统计要区分「0 B」和「读不到」，不能用 — 表示空。 */
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
  const [version, setVersion] = useState<string>("");
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

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const requestId = useRef(0);
  const filterTimer = useRef<number | undefined>(undefined);
  const cleanedVersion = useRef(dataVersion);
  const anchorRef = useRef<string | null>(null);
  const [gridWidth, setGridWidth] = useState(0);

  const queueIds = useMemo(() => new Set((queue?.items ?? []).map((item) => item.asset_id)), [queue]);
  const rowById = useMemo(() => new Map(rows.map((asset) => [asset.id, asset])), [rows]);
  const columns = Math.max(2, Math.min(6, Math.floor((gridWidth + GAP) / (CARD_MIN_WIDTH + GAP))));

  // 分组表可能很大（真实库 401 组），用 id → 组 的索引，渲染时不做 O(n) 查找。
  const groupIndex = useMemo(() => {
    const index = new Map<string, SpaceGroup>();
    for (const group of groups) {
      for (const id of group.ids ?? []) index.set(id, group);
    }
    return index;
  }, [groups]);

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

  // 重复图视角：指纹没算完时给一个「立即计算」，真跑 lifelog dedup --build。
  const computeDup = useCallback(async () => {
    if (computing) return;
    setComputing(true);
    try {
      const result = (await dedupBuild()) as { errors?: number } | null;
      if (result && typeof result.errors === "number" && result.errors > 0) {
        onToast("指纹计算完成，但仍有 " + result.errors + " 张失败，详情见设置页日志");
      } else {
        onToast("指纹已计算完成");
      }
      void refreshStats();
      void refreshQueue();
    } catch (reason) {
      onToast("计算指纹失败：" + String(reason));
    } finally {
      setComputing(false);
    }
  }, [computing, onToast, refreshQueue, refreshStats]);

  useEffect(() => {
    void refreshQueue();
    void refreshStats();
  }, [refreshQueue, refreshStats, dataVersion]);

  // 清单在别处被改（比如真实清理）时重新对齐。
  useEffect(() => {
    if (dataVersion === cleanedVersion.current) return;
    cleanedVersion.current = dataVersion;
    void refreshQueue();
    void refreshStats();
  }, [dataVersion, refreshQueue, refreshStats]);

  // 分组只跟「视角 + 库内容指纹」有关：切视角不用重新扫库，库变了才重拉。
  useEffect(() => {
    if (view !== "dup" && view !== "screenshot") {
      setGroups([]);
      return;
    }
    let alive = true;
    spaceGroups(view)
      .then((result) => {
        if (alive) setGroups(result.groups);
      })
      .catch(() => {
        if (alive) setGroups([]);
      });
    return () => {
      alive = false;
    };
  }, [view, version]);

  const fetchPage = useCallback(async (offset: number) => {
    if (offset === 0) setLoading(true);
    else setLoadingMore(true);
    const ticket = ++requestId.current;
    try {
      // 首屏 200 个；滚动到底再按 offset 取下一页。视角过滤在服务端做。
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
      // 不在这一页里的 id（比如「同一 size 的第 51 张」）没有 size 可算，先用 0 占位，
      // 等服务端返回总数/字节后再校正；不能把它们从清单里漏掉。
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
        .reduce<Promise<{ changed?: number; count: number; bytes: number }>>((pending, chunk) =>
          pending.then((last) =>
            (add ? cleanupAdd(chunk) : cleanupRemove(chunk)).then((next) => ({ ...next, changed: (last.changed ?? 0) + (next.changed ?? 0) })),
          ),
          Promise.resolve({ changed: 0, count: 0, bytes: 0 }),
        )
        .then((change) => {
          // 以服务端返回的总数/字节为准；未知行（比如整组）：拉一次清单把缩略图补齐。
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

  const toggleGroup = useCallback(
    (group: SpaceGroup, add: boolean) => {
      const ids = group.ids ?? [];
      if (!ids.length) return;
      // 重复图整组切换时，keeper 不参与「加入」：点组内任意一张 = 整组移入/移出。
      const target = add ? ids.filter((id) => id !== group.keep) : ids;
      if (!target.length) return;
      applyQueue(target, add);
    },
    [applyQueue],
  );

  // 键盘：方向键在网格里移动焦点，空格/回车切换待清理（双击/打开详情留给鼠标）。
  const moveFocus = useCallback(
    (delta: number, extend: boolean) => {
      if (!rows.length) return;
      const current = focusId ? rows.findIndex((asset) => asset.id === focusId) : -1;
      const next = Math.max(0, Math.min(rows.length - 1, (current < 0 ? 0 : current) + delta));
      const asset = rows[next];
      if (!asset) return;
      setFocusId(asset.id);
      if (extend) {
        toggleAssets([asset], !queueIds.has(asset.id));
      }
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
          toggleAssets([asset], !queueIds.has(asset.id));
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [columns, focusId, moveFocus, queueIds, rows, toggleAssets]);

  const handleCardClick = useCallback(
    (asset: Asset, event: React.MouseEvent) => {
      const group = groupIndex.get(asset.id) ?? null;
      const inQueue = queueIds.has(asset.id);
      setFocusId(asset.id);

      if (event.shiftKey && anchorRef.current) {
        const from = rows.findIndex((item) => item.id === anchorRef.current);
        const to = rows.findIndex((item) => item.id === asset.id);
        if (from >= 0 && to >= 0) {
          const [start, end] = from <= to ? [from, to] : [to, from];
          const range = rows.slice(start, end + 1);
          toggleAssets(range, !inQueue);
          return;
        }
      }

      // 重复图：点组内任意一张，整组一起切（保留的那张不参与加入）。
      if (group && view === "dup") {
        toggleGroup(group, !inQueue);
        anchorRef.current = asset.id;
        return;
      }

      toggleAssets([asset], !inQueue);
      anchorRef.current = asset.id;
    },
    [groupIndex, queueIds, rows, toggleAssets, toggleGroup, view],
  );

  // 重复图视角：每组的非 keeper 成员默认勾上待清理。
  // 真实库有几千组，不能一次全塞进清单：只处理「已经载入到网格的组」，每组只默认一次，
  // 滚动加载到新组时再补勾；用户之后手动取消过的组不会被重新勾上。
  const autoDupRef = useRef<Set<string>>(new Set());
  const autoDupVersion = useRef("");
  useEffect(() => {
    if (view !== "dup" || !groups.length) return;
    if (autoDupVersion.current !== version) {
      // 库内容变了（重新算过指纹/删过图）：旧记忆作废，重新给一次默认。
      autoDupVersion.current = version;
      autoDupRef.current = new Set();
    }
    if (!rowById.size) return;
    const fresh: string[] = [];
    for (const group of groups) {
      if (autoDupRef.current.has(group.key)) continue;
      const loaded = (group.ids ?? []).filter((id) => rowById.has(id));
      if (!loaded.length) continue;
      autoDupRef.current.add(group.key);
      fresh.push(...loaded.filter((id) => id !== group.keep));
    }
    if (fresh.length) applyQueue(Array.from(new Set(fresh)), true);
  }, [applyQueue, groups, rowById, version, view]);

  // 网格按行虚拟化：行高由列宽算出（16:10 卡片 + 间距），滚动时不重排。
  const cardWidth = gridWidth > 0 ? (gridWidth - GAP * (columns - 1)) / columns : CARD_MIN_WIDTH;
  const cardHeight = Math.round(cardWidth * 0.625) + 8;
  const rowCount = Math.ceil(rows.length / columns);
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => cardHeight + GAP,
    overscan: 2,
  });

  useEffect(() => {
    virtualizer.measure();
  }, [cardHeight, columns, virtualizer]);

  const currentStat = views?.[view];
  // 后端 space-views 会带 ready；缺省时按「有没有组」判断。
  const dupReady = views?.dup ? views.dup.ready !== false : false;
  const queueTotal = queue?.count ?? 0;
  const queueBytes = queue?.bytes ?? 0;
  const focused = focusedId(rows, queue, focusId);

  const summaryLine = currentStat
    ? `${currentStat.count.toLocaleString()} 个 · ${statBytes(currentStat.bytes)}`
    : loading
      ? "读取中…"
      : "";

  return (
    <div className="space-view">
      <div className="space-view-pills" role="tablist" aria-label="清理视角">
        {VIEWS.map((item) => {
          const stat = views?.[item.key];
          return (
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
              <em>
                {stat ? `${stat.count.toLocaleString()} · ${statBytes(stat.bytes)}` : "…"}
                {item.key === "dup" && stat?.groups ? ` · ${stat.groups} 组` : ""}
              </em>
            </button>
          );
        })}
      </div>

      <div className="space-columns">
        <section className="space-pane space-rank" aria-label="文件网格">
          <div className="space-pane-head">
            <div className="space-rank-title">
              <h2>{VIEWS.find((item) => item.key === view)?.label}</h2>
              <p>
                {summaryLine}
                {currentStat?.rule ? ` · ${currentStat.rule}` : ""}
                {hasMore ? " · 已载入 " + rows.length + "+" : ""}
              </p>
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
                  placeholder="按路径筛选…"
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
            </div>
          </div>

          {(view === "screenshot" || view === "dup") && groups.length > 0 && (
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
                    title={group.reason ? `reason: ${group.reason}` : addLabel(inQueue, ids.length)}
                    onClick={() => {
                      const add = candidates.some((id) => !queueIds.has(id));
                      // keeper 永不进待清理：新建组/全选本组都把它排除。
                      applyQueue(add ? candidates.filter((id) => !queueIds.has(id)) : candidates, add);
                    }}
                  >
                    <strong>{group.label}</strong>
                    <span>{ids.length} 张（保留 1）· 可回收 {statBytes(group.reclaim_bytes ?? 0)}</span>
                    <em>{inQueue === candidates.length && candidates.length > 0 ? "全部已勾选" : "全选本组待清理"}</em>
                  </button>
                );
              })}
            </div>
          )}

          {view === "dup" && groups.length > 0 && (
            <p className="space-view-note">
              {groups.length} 组真实指纹 · 组内保留 1 张（标「保留」），其余默认勾上待清理；点组内任意一张切换整组，keeper 永不进待清理。
            </p>
          )}

          <div
            className="space-grid"
            ref={scrollRef}
            role="grid"
            aria-label="文件缩略图"
            aria-multiselectable="true"
          >
            <div ref={gridRef} className="space-grid-inner" style={{ height: Math.max(virtualizer.getTotalSize(), cardHeight) + "px" }}>
              {gridWidth > 0 &&
                virtualizer.getVirtualItems().map((virtualRow) => {
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
                      {items.map((asset) => {
                        const group = groupIndex.get(asset.id);
                        return (
                          <SpaceCard
                            key={asset.id}
                            asset={asset}
                            inQueue={queueIds.has(asset.id)}
                            focused={focusId === asset.id}
                            dupCount={group?.count ?? asset.dup_count ?? 0}
                            keeper={group?.keep === asset.id}
                            onToggle={handleCardClick}
                            onOpen={() => onOpenDetail(entryFromAsset(asset), rows)}
                          />
                        );
                      })}
                    </div>
                  );
                })}
              {loading && rows.length === 0 && (
                <div className="space-grid-loading">
                  <LoaderCircle size={16} className="spin" />
                  <span>正在读取文件…</span>
                </div>
              )}
            </div>
            <div ref={sentinelRef} className="space-sentinel">
              {loadingMore ? (
                <span><LoaderCircle size={12} className="spin" /> 正在加载更多…</span>
              ) : hasMore ? (
                <span>继续下滑载入更多</span>
              ) : rows.length > 0 ? (
                <span>已到列表末尾</span>
              ) : null}
            </div>
            {error && <div className="space-empty">读取失败：{error}</div>}
            {!loading && !error && rows.length === 0 && (
              <div className="space-empty">
                {view === "dup" && !dupReady ? (
                  <>
                    <LoaderCircle size={20} strokeWidth={1.5} className={computing ? "spin" : undefined} />
                    <strong>{computing ? "正在为照片计算指纹…" : "照片指纹还没算"}</strong>
                    <span>
                      去重需要先对每张图算 dhash（l0 字节 / l1 像素 / burst 连拍）。算完后这里会出现真实分组。
                    </span>
                    <button type="button" className="primary-btn" onClick={() => void computeDup()} disabled={computing}>
                      {computing ? "计算中…" : "立即计算"}
                    </button>
                  </>
                ) : (
                  <>
                    <ImageOff size={20} strokeWidth={1.5} />
                    <strong>{pathFilter ? "没有匹配「" + pathFilter + "」的文件" : "这个视角下还没有文件"}</strong>
                    {view === "screenshot" && <span>截屏按路径含 Screenshot/截屏/屏幕，或识别结果里的 scene/tags 命中「屏幕截图」两层一起筛。</span>}
                  </>
                )}
              </div>
            )}
          </div>
        </section>

        <section className="space-pane space-preview" aria-label="选中项预览">
          <div className="space-pane-head">
            <div>
              <h2>预览</h2>
              <p>{focused ? kindText(focused) + " · " + formatBytes(focused.size ?? 0) : "点一个格子，这里显示大图或播放视频"}</p>
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
              <span>点一个格子：这里显示原图；视频可以直接播放。双击打开详情。</span>
            </div>
          )}
        </section>

        <section className="space-pane space-queue" aria-label="待清理清单">
          <div className="space-pane-head">
            <div>
              <h2>待清理</h2>
              <p>{queueTotal} 个 · {statBytes(queueBytes)} · 只记清单，不动文件</p>
            </div>
            {queueTotal > 0 && (
              <button
                type="button"
                className="space-link"
                disabled={busy}
                onClick={async () => {
                  const ids = (queue?.items ?? []).map((item) => item.asset_id);
                  if (!ids.length) return;
                  const previous = queue;
                  setQueue({ items: [], count: 0, bytes: 0 });
                  setBusy(true);
                  try {
                    const change = await cleanupRemove(ids);
                    setQueue({ items: [], count: change.count, bytes: change.bytes });
                    void refreshStats();
                  } catch (reason) {
                    setQueue(previous);
                    onToast("移出待清理失败：" + String(reason));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <Undo2 size={12} strokeWidth={1.9} /> 全部移出
              </button>
            )}
          </div>

          <div className="space-queue-list" role="list">
            {(queue?.items ?? []).length === 0 ? (
              <div className="space-queue-empty">
                <CheckSquare size={22} strokeWidth={1.4} />
                <strong>待清理清单是空的</strong>
                <span>点一下左边任意格子就会加入；再点一下取消。这一步只记清单，不动文件。</span>
                <span>确认后点右下角「清理」，原图才会移进废纸篓、库里的记录一并移除。</span>
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
                    <span className="space-queue-meta">
                      {formatBytes(entry.size ?? 0)} · {entry.kind === "video" ? "视频" : "照片"}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="space-queue-remove"
                    onClick={() => applyQueue([entry.asset_id], false)}
                    disabled={busy}
                    aria-label="从待清理移出"
                    title="移出清单（不删文件）"
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
                  上次已清理 {lastClean.count} 个 · {statBytes(lastClean.bytes)}，文件在废纸篓
                </em>
              )}
              <span>清理后原图移进废纸篓，记录同时移除；需要时可从废纸篓找回文件。</span>
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
              <Trash2 size={13} strokeWidth={2} /> 清理 {queueTotal > 0 ? queueTotal : ""}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

function addLabel(inQueue: number, total: number): string {
  return inQueue === total ? "本组已全部在待清理，点一下移出" : "把本组全部加入待清理";
}

function focusedId(rows: Asset[], queue: CleanupList | null, id: string | null): CleanupEntry | null {
  if (!id) return null;
  const asset = rows.find((item) => item.id === id);
  if (asset) return entryFromAsset(asset);
  const item = queue?.items.find((entry) => entry.asset_id === id);
  return item ?? null;
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

