import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import {
  Check,
  CheckSquare,
  ChevronsDown,
  ExternalLink,
  Film,
  Maximize2,
  HardDrive,
  Image as ImageIcon,
  LoaderCircle,
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
  openExternal as openExternalPath,
  queryAssets,
  revealInFinder,
  spaceSummary,
  type Asset,
  type CleanupEntry,
  type CleanupList,
  type SpaceSummary,
} from "../api";
import { formatBytes, kindLabel, timeLabel } from "../utils";

const PAGE_SIZE = 200;

function cleanPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 2 ? "…/" + parts.slice(-2).join("/") : path;
}

function kindText(entry: CleanupEntry): string {
  if (entry.kind === "video") return "视频";
  if (entry.kind === "live" || entry.kind === "live_photo") return "实况";
  return "照片";
}

/** 视频的缩略图就是抽好的首帧；没有就只报大小和文件名，不塞一个裂图标。 */
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
  /** 打开大图详情（图片/视频通用）。list 是当前已载入的大小排行，详情里可以前后翻页。 */
  onOpenDetail: (entry: CleanupEntry, list: Asset[]) => void;
  /** 交给 App 统一渲染删除确认（DeleteDialog），清理后由 App 通知我们刷新。 */
  onClean: (ids: string[], rect: DOMRect) => void;
  onToast: (text: string, action?: { label: string; run: () => void }) => void;
  /** 真实清理成功后 App 会加一，用来重新拉清单和统计。 */
  dataVersion: number;
  /** 已载入的大小排行同步给 App，预览翻页就在这一页里走。 */
  onRows: (rows: Asset[]) => void;
};

export function SpaceView({ onOpenDetail, onClean, onToast, dataVersion, onRows }: Props) {
  // 清空清单后保留一句本地提示：结算区恢复成 0 B，但刚刚清掉多少还要看得见。
  const [lastClean, setLastClean] = useState<{ count: number; bytes: number } | null>(null);
  const cleanedVersion = useRef(dataVersion);
  const [summary, setSummary] = useState<SpaceSummary | null>(null);
  const [rows, setRows] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queue, setQueue] = useState<CleanupList | null>(null);
  const [selection, setSelection] = useState<string[]>([]);
  const [, setAnchorState] = useState<string | null>(null);
  // 连点时 React 还没重渲染，闭包里的 anchor 会停在旧值；range 选必须读同步的 ref。
  const anchorRef = useRef<string | null>(null);
  const setAnchor = useCallback((id: string | null) => {
    anchorRef.current = id;
    setAnchorState(id);
  }, []);
  const [busy, setBusy] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  // 大库不必翻页找：输入路径/文件名片段就能从服务端直接筛出来（中文也按子串匹配）。
  const [filterInput, setFilterInput] = useState("");
  const [pathFilter, setPathFilter] = useState("");

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const requestId = useRef(0);
  const filterTimer = useRef<number | undefined>(undefined);
  const queueIds = useMemo(() => new Set((queue?.items ?? []).map((item) => item.asset_id)), [queue]);
  const selectedSet = useMemo(() => new Set(selection), [selection]);
  const rowById = useMemo(() => new Map(rows.map((asset) => [asset.id, asset])), [rows]);

  const refreshQueue = useCallback(async () => {
    try {
      setQueue(await cleanupList());
    } catch (reason) {
      onToast("读取待清理清单失败：" + String(reason));
    }
  }, [onToast]);

  const refreshSummary = useCallback(() => {
    spaceSummary().then(setSummary).catch(() => undefined);
  }, []);

  useEffect(() => {
    void refreshQueue();
    refreshSummary();
  }, [refreshQueue, refreshSummary, dataVersion]);

  // 真实清理完成后 App 会加一：先重新拉清单和统计，再清掉「刚刚加入/选中」的本地状态，
  // 否则会出现清单已经 0 条、底部还写着 0 个的同一帧。
  useEffect(() => {
    if (dataVersion === cleanedVersion.current) return;
    cleanedVersion.current = dataVersion;
    void refreshQueue();
    refreshSummary();
    setSelection([]);
  }, [dataVersion, refreshQueue, refreshSummary]);

  const fetchPage = useCallback(async (offset: number) => {
    if (offset === 0) setLoading(true);
    else setLoadingMore(true);
    const ticket = ++requestId.current;
    try {
      // 按大小降序、offset 分页：单次 200 条，避开 queryAssets 的 2000 上限。
      const page = await queryAssets({
        limit: PAGE_SIZE,
        offset,
        sort: "size_desc",
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
  }, []);

  useEffect(() => {
    setRows([]);
    void fetchPage(0);
  }, [fetchPage, dataVersion, pathFilter]);

  useEffect(() => {
    onRows(rows);
  }, [onRows, rows]);

  const loadMore = useCallback(() => {
    if (loading || loadingMore || !hasMore) return;
    void fetchPage(rows.length);
  }, [fetchPage, hasMore, loading, loadingMore, rows.length]);

  // 滚到接近底部再取下一页。首屏只渲染 200 条，不把整库拉进内存。
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

  const handlePick = useCallback(
    (asset: Asset, event: React.MouseEvent) => {
      const pivot = anchorRef.current;
      if (event.shiftKey && pivot) {
        const from = rows.findIndex((item) => item.id === pivot);
        const to = rows.findIndex((item) => item.id === asset.id);
        if (from >= 0 && to >= 0) {
          const [start, end] = from <= to ? [from, to] : [to, from];
          const range = rows.slice(start, end + 1).map((item) => item.id);
          setSelection((previous) => Array.from(new Set([...previous, ...range])));
        }
      } else if (event.metaKey || event.ctrlKey) {
        setSelection((previous) =>
          previous.includes(asset.id) ? previous.filter((id) => id !== asset.id) : [...previous, asset.id],
        );
        setAnchor(asset.id);
      } else {
        setSelection([asset.id]);
        setAnchor(asset.id);
      }
      setFocusId(asset.id);
      // 普通单击只选中；双击由下面的 openRow 打开大图预览。
    },
    [rows, setAnchor],
  );

  const openRow = useCallback(
    (asset: Asset) => {
      onOpenDetail(entryFromAsset(asset), rows);
    },
    [onOpenDetail, rows],
  );

  const addSelected = useCallback(async () => {
    if (!selection.length || busy) return;
    const ids = selection.filter((id) => !queueIds.has(id));
    if (!ids.length) {
      onToast("选中的都已经在待清理清单里了");
      return;
    }
    setBusy(true);
    try {
      const change = await cleanupAdd(ids);
      const added = ids
        .map((id) => rowById.get(id))
        .filter((asset): asset is Asset => Boolean(asset))
        .map(entryFromAsset);
      // 先在本地补进清单，再用服务端的总数/字节校正，点完马上能看到。
      setQueue((previous) => ({
        items: [...added, ...(previous?.items ?? [])],
        count: change.count,
        bytes: change.bytes,
      }));
      setSelection([]);
      refreshSummary();
      onToast(
        change.changed
          ? "已加入待清理 " + change.changed + " 个 · 清单共 " + change.count + " 个 / " + formatBytes(change.bytes)
          : "这些已经在待清理清单里了",
      );
    } catch (reason) {
      onToast("加入待清理失败：" + String(reason));
    } finally {
      setBusy(false);
    }
  }, [busy, onToast, queueIds, refreshSummary, rowById, selection]);

  const addEntry = useCallback(
    async (id: string) => {
      if (busy || queueIds.has(id)) return;
      const asset = rowById.get(id);
      if (!asset) return;
      setBusy(true);
      try {
        const change = await cleanupAdd([id]);
        setQueue((previous) => ({
          items: [entryFromAsset(asset), ...(previous?.items ?? [])],
          count: change.count,
          bytes: change.bytes,
        }));
        refreshSummary();
        onToast("已加入待清理 · 清单共 " + change.count + " 个 / " + formatBytes(change.bytes));
      } catch (reason) {
        onToast("加入待清理失败：" + String(reason));
      } finally {
        setBusy(false);
      }
    },
    [busy, onToast, queueIds, refreshSummary, rowById],
  );

  const restoreIds = useCallback(
    async (ids: string[], silent = false) => {
      if (!ids.length) return;
      setBusy(true);
      try {
        const change = await cleanupRemove(ids);
        const drop = new Set(ids);
        setQueue((previous) => ({
          items: (previous?.items ?? []).filter((item) => !drop.has(item.asset_id)),
          count: change.count,
          bytes: change.bytes,
        }));
        refreshSummary();
        if (!silent) onToast("已从待清理移出 " + ids.length + " 个，原图没有被动过");
      } catch (reason) {
        onToast("移出待清理失败：" + String(reason));
      } finally {
        setBusy(false);
      }
    },
    [onToast, refreshSummary],
  );

  const focusedEntry = useMemo(() => {
    const fromQueue = queue?.items.find((item) => item.asset_id === focusId);
    if (fromQueue) return fromQueue;
    const asset = focusId ? rowById.get(focusId) : null;
    return asset ? entryFromAsset(asset) : null;
  }, [focusId, queue, rowById]);

  // 预览优先显示焦点项；没有焦点时显示选中项里最大的那个。
  const preview = useMemo(() => {
    if (focusedEntry) return focusedEntry;
    const biggest = selection
      .map((id) => rowById.get(id))
      .filter((asset): asset is Asset => Boolean(asset))
      .sort((a, b) => (b.size ?? 0) - (a.size ?? 0))[0];
    return biggest ? entryFromAsset(biggest) : null;
  }, [focusedEntry, rowById, selection]);

  const selectedBytes = useMemo(
    () =>
      selection.reduce((sum, id) => sum + (rowById.get(id)?.size ?? 0), 0),
    [rowById, selection],
  );

  // 列表用普通滚动而不是虚拟滚动：大库首屏只有 200 行，DOM 开销可以接受；
  // 虚拟化需要给每行固定高度，而鼠标滚轮在 WKWebView 里会跳过没渲染的行，直接滚不到。
  const ROW_HEIGHT = 62;

  const queueTotal = queue?.count ?? 0;
  const queueBytes = queue?.bytes ?? 0;

  return (
    <div className="space-view">
      {summary && (
        <div className="space-stats">
          <div className="space-stat">
            <span><HardDrive size={12} strokeWidth={1.8} /> 照片库</span>
            <strong>{statBytes(summary.bytes)}</strong>
            <em>{summary.assets.toLocaleString()} 个文件</em>
          </div>
          <div className="space-stat">
            <span><Film size={12} strokeWidth={1.8} /> 视频</span>
            <strong>{statBytes(summary.videos.bytes)}</strong>
            <em>{summary.videos.count.toLocaleString()} 个</em>
          </div>
          <div className="space-stat">
            <span><ChevronsDown size={12} strokeWidth={1.8} /> 大于 100 MB 的视频</span>
            <strong>{statBytes(summary.big_videos.bytes)}</strong>
            <em>{summary.big_videos.count.toLocaleString()} 个</em>
          </div>
          <div className="space-stat">
            <span><ImageIcon size={12} strokeWidth={1.8} /> 照片</span>
            <strong>{statBytes(summary.photos.bytes)}</strong>
            <em>{summary.photos.count.toLocaleString()} 个</em>
          </div>
        </div>
      )}

      <div className="space-columns">
        <section className="space-pane space-rank" aria-label="文件大小排行">
          <div className="space-pane-head">
            <div>
              <h2>大小排行</h2>
              <p>{loading ? "读取中…" : "已载入 " + rows.length + " 个" + (pathFilter ? " · 筛选 " + pathFilter : " · 从大到小")}</p>
            </div>
            <div className="space-rank-tools">
              <span className="space-hint">⇧ 连选 · ⌘ 点选</span>
              <div className="space-filter">
                <Search size={11} strokeWidth={1.8} />
                <input
                  value={filterInput}
                  onChange={(event) => {
                    const value = event.target.value;
                    setFilterInput(value);
                    // 短片段（比如 "_sgcheck"）也立即生效，不等 debounce，避免看起来像没筛。
                    window.clearTimeout(filterTimer.current);
                    filterTimer.current = window.setTimeout(() => setPathFilter(value.trim()), 0);
                  }}
                  placeholder="按路径筛选…"
                  aria-label="按路径筛选大小排行"
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

          <div
            className="space-list"
            ref={scrollRef}
            role="listbox"
            aria-multiselectable="true"
            aria-label="按大小排序的文件"
          >
            <div>
              {rows.map((asset) => {
                return (
                  <div
                    key={asset.id}
                    data-asset-row={asset.id}
                    role="option"
                    aria-selected={selectedSet.has(asset.id)}
                    className={clsx(
                      "space-row",
                      selectedSet.has(asset.id) && "selected",
                      focusId === asset.id && "focused",
                    )}
                    style={{ height: ROW_HEIGHT + "px" }}
                    onClick={(event) => handlePick(asset, event)}
                    onDoubleClick={() => openRow(asset)}
                  >
                    <span className="space-check" aria-hidden="true">
                      {selectedSet.has(asset.id) && <Check size={11} strokeWidth={2.6} />}
                    </span>
                    <span className="space-row-main">
                      <strong>
                        {asset.kind === "video" ? <Film size={11} strokeWidth={1.8} /> : null}
                        {cleanPath(asset.path)}
                      </strong>
                      <em>
                        {formatBytes(asset.size ?? 0)} · {kindLabel(asset)}
                        {queueIds.has(asset.id) ? " · 已在待清理" : ""}
                      </em>
                    </span>
                  </div>
                );
              })}
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
            {!loading && !error && rows.length === 0 && <div className="space-empty">库里还没有文件</div>}
          </div>

          <div className="space-bulk">
            <span>已选 {selection.length} 个 · {formatBytes(selectedBytes)}</span>
            <button
              type="button"
              className="space-primary"
              onClick={() => void addSelected()}
              disabled={!selection.length || busy}
            >
              <Plus size={13} strokeWidth={2} /> 加入待清理
            </button>
          </div>
        </section>

        <section className="space-pane space-preview" aria-label="选中项预览">
          <div className="space-pane-head">
            <div>
              <h2>预览</h2>
              <p>{preview ? kindText(preview) + " · " + formatBytes(preview.size ?? 0) : "点一个文件，这里显示原图或播放视频"}</p>
            </div>
          </div>
          {preview ? (
            <PreviewBody
              entry={preview}
              inQueue={queueIds.has(preview.asset_id)}
              onOpenDetail={() => onOpenDetail(preview, rows)}
              busy={busy}
              onReveal={() => {
                void revealInFinder(preview.path).catch(() => onToast("在 Finder 中显示失败"));
              }}
              onAdd={() => void addEntry(preview.asset_id)}
              onRemove={() => void restoreIds([preview.asset_id])}
            />
          ) : (
            <div className="space-preview-empty">
              <ImageIcon size={26} strokeWidth={1.4} />
              <span>选中左侧的文件后，这里显示原图；视频可以直接播放。</span>
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
                onClick={() => void restoreIds((queue?.items ?? []).map((item) => item.asset_id), true)}
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
                <span>在左边挑出想删的文件，点「加入待清理」先放进来；这一步只记清单，不动文件。</span>
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
                    <span className="space-queue-name">{cleanPath(entry.path)}</span>
                    <span className="space-queue-meta">
                      {formatBytes(entry.size ?? 0)}
                      {entry.source && entry.source !== "space" ? " · " + entry.source : ""}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="space-queue-remove"
                    onClick={() => void restoreIds([entry.asset_id])}
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
                // onClean 只负责打开确认卡；真正删完由 dataVersion 触发上面的刷新。
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

