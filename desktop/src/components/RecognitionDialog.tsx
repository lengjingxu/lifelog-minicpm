import clsx from "clsx";
import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  AlertCircle,
  CheckCircle2,
  Cloud,
  CloudDownload,
  FolderSearch,
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import {
  assetSrc,
  generateThumbs,
  importFolder,
  importXiaomi,
  isTauri,
  pickFolder,
  thumbStatus,
  type Asset,
  type ImportPlan,
} from "../api";
import { importProgressText, type ImportProgress } from "./ImportDialog";
import type { LiveController } from "../live";
import { useDialogFocus, type GrowRect } from "../useDialogFocus";

type Props = {
  open: boolean;
  live: LiveController;
  assets: Map<string, Asset>;
  onClose: () => void;
  origin?: string;
  originRect?: GrowRect | null;
  closing?: boolean;
  /** 导入/识别完成后让 App 刷新库与缩略图。 */
  onImported?: () => Promise<void> | void;
};

function extractMessage(value: unknown): string {
  const raw = typeof value === "string" ? value : value instanceof Error ? value.message : String(value);
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.message === "string") return parsed.message;
  } catch {
    // 不是 JSON 就原样返回
  }
  return raw;
}

function gb(bytes: number): string {
  return bytes >= 1e9 ? (bytes / 1e9).toFixed(1) + " GB" : Math.max(1, Math.round(bytes / 1e6)) + " MB";
}

function formatRemaining(total: number, done: number, rate: number | null): string {
  if (rate === null) return "等待测速";
  if (rate <= 0) return "计算中";
  if (done >= total || total <= 0) return "00:00";
  const seconds = Math.ceil((total - done) / rate);
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

export function RecognitionDialog({
  open,
  live,
  assets,
  onClose,
  origin = "50% 100%",
  originRect = null,
  closing = false,
  onImported,
}: Props) {
  const [count, setCount] = useState(18);
  const [concurrency, setConcurrency] = useState(4);
  const [speed, setSpeed] = useState(2);
  const [submitting, setSubmitting] = useState(false);
  const dialogRef = useDialogFocus<HTMLElement>(onClose, { enabled: open, growFrom: originRect });

  const view = live.view;
  const total = Math.max(0, view.active ? view.total : count);
  const done = Math.min(total, Math.max(0, view.done));
  const failed = Math.min(Math.max(0, view.failed), Math.max(0, total - done));
  const pending = Math.max(0, total - done - failed);
  const progress = total > 0 ? Math.min(100, (done / total) * 100) : 0;
  const running = view.status === "running";
  const terminal = live.events.some(
    (event) => event.type === "session_done" || event.type === "session_stopped",
  );
  const finished = view.active && !running && !view.paused && (done + failed >= total || terminal);

  const inFlight = useMemo(() => {
    const latest = new Map<number, string>();
    for (const event of live.events) {
      if (event.type === "start" && event.asset_id) latest.set(event.slot ?? 0, event.asset_id);
      if ((event.type === "done" || event.type === "error") && event.asset_id) {
        for (const [slot, id] of latest) {
          if (id === event.asset_id) latest.delete(slot);
        }
      }
    }
    return [...latest.entries()]
      .sort((a, b) => a[0] - b[0])
      .slice(0, 3)
      .map(([slot, id]) => ({ slot, asset: assets.get(id) }));
  }, [live.events, assets]);

  if (!open) return null;

  const begin = async () => {
    setSubmitting(true);
    try {
      await live.start({ mode: "sim", count, concurrency, speed });
    } finally {
      setSubmitting(false);
    }
  };

  const [importPlan, setImportPlan] = useState<ImportPlan | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importStage, setImportStage] = useState<string>("");
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  const importTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!open) return;
    let unlisten: (() => void) | undefined;
    void listen<ImportProgress>("import-progress", (event) => {
      setImportProgress(event.payload);
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);
    return () => unlisten?.();
  }, [open]);

  useEffect(() => {
    if (!open || !isTauri) return;
    let alive = true;
    const tick = () => {
      thumbStatus()
        .then((status) => {
          if (!alive) return;
          setImportStage(`本地索引 ${status.assets.toLocaleString()} 个 · 缩略图 ${status.thumbs.toLocaleString()} 个`);
        })
        .catch(() => undefined);
    };
    tick();
    importTimer.current = window.setInterval(tick, 4000);
    return () => {
      alive = false;
      window.clearInterval(importTimer.current);
    };
  }, [open]);

  const previewImport = async () => {
    setImportBusy(true);
    setImportError(null);
    try {
      const plan = await importXiaomi(true);
      setImportPlan(plan);
    } catch (reason: unknown) {
      const message = extractMessage(reason);
      setImportError(message);
      setImportPlan(null);
    } finally {
      setImportBusy(false);
    }
  };

  const startImport = async () => {
    setImportBusy(true);
    setImportError(null);
    setImportProgress({ message: "正在准备导入…" });
    try {
      await importXiaomi(false);
      await generateThumbs(false);
      if (onImported) await onImported();
      setImportPlan(null);
      setImportProgress(null);
    } catch (reason: unknown) {
      const message = extractMessage(reason);
      setImportError(message);
    } finally {
      setImportBusy(false);
    }
  };

  const importLocal = async () => {
    const folder = await pickFolder({ title: "选择要导入的文件夹" });
    if (!folder) return;
    setImportBusy(true);
    setImportError(null);
    try {
      const result = await importFolder(folder);
      if (!result.ok) throw new Error("导入没有返回成功");
      await generateThumbs(false);
      if (onImported) await onImported();
    } catch (reason: unknown) {
      setImportError(extractMessage(reason));
    } finally {
      setImportBusy(false);
    }
  };

  const primary = (() => {
    if (submitting || live.busy) {
      return (
        <button type="button" className="primary-button" disabled>
          <LoaderCircle size={14} className="spin" /> 正在准备
        </button>
      );
    }
    if (running) {
      return (
        <button type="button" className="primary-button" onClick={() => void live.pause()}>
          <Pause size={14} /> 暂停预览
        </button>
      );
    }
    if (view.active && view.paused) {
      return (
        <button type="button" className="primary-button" onClick={() => void live.resume()}>
          <Play size={14} /> 继续预览
        </button>
      );
    }
    return (
      <button type="button" className="primary-button" onClick={() => void begin()}>
        <Sparkles size={14} /> {view.active ? "再跑一轮预览" : "预览识别流程"}
      </button>
    );
  })();

      return (
        <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
          <section
            ref={dialogRef}
            className={clsx("recognition-dialog dialog glass-surface", closing && "closing")}
            style={{ ["--dialog-origin" as string]: origin }}
            role="dialog"
            aria-modal="true"
            aria-label="导入与识别"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="dialog-head">
              <div>
                <div className="eyebrow">IMPORT &amp; RECOGNITION</div>
                <h2>导入与识别</h2>
                <p>小米云导入、本地文件夹导入都在这里；真实识别在详情页逐张触发。</p>
              </div>
              <button type="button" className="icon-button" onClick={onClose} aria-label="关闭">
                <X size={16} />
              </button>
            </header>

            {(live.error || live.errorMessage) && (
              <div className="inline-alert">
                <AlertCircle size={15} />
                <div>
                  <strong>识别服务报错</strong>
                  <span>{live.errorMessage ?? live.error}</span>
                </div>
              </div>
            )}

            <div className="recognition-grid">
              <section className="recognition-block import-block">
                <div className="block-title">
                  <Cloud size={16} />
                  <span>导入照片</span>
                  <span className="status-pill">{importBusy ? "进行中" : "真实链路"}</span>
                </div>
                <p className="block-copy">小米云先预演再下载；本地文件夹直接建索引。导入后自动补缩略图。</p>
                <div className="import-row">
                  <div>
                    <strong>{importStage || "读取本地索引…"}</strong>
                    <span>{importError ?? (importProgress ? importProgressText(importProgress) : "只下载到本地，云端只读")}</span>
                  </div>
                  <button type="button" className="ghost-button" onClick={() => void previewImport()} disabled={importBusy}>
                    <RefreshCw size={13} /> 扫描云相册
                  </button>
                </div>
                {importPlan && (
                  <div className="import-plan">
                    <p className="dialog-text">
                      区间内共 {importPlan.listed} 张：将新增 <b>{importPlan.new}</b> 张，本地已有 <b>{importPlan.existing}</b> 张。
                    </p>
                    <p className="dialog-text dim">需要下载约 {gb(importPlan.bytes)}；中断可续传。</p>
                    <div className="dialog-actions">
                      <button type="button" className="ghost-button" onClick={() => setImportPlan(null)} disabled={importBusy}>
                        取消
                      </button>
                      <button type="button" className="primary-button" onClick={() => void startImport()} disabled={importBusy}>
                        <CloudDownload size={14} /> {importBusy ? "导入中…" : "开始导入"}
                      </button>
                    </div>
                  </div>
                )}
                <button type="button" className="ghost-button full" onClick={() => void importLocal()} disabled={importBusy || !isTauri}>
                  <FolderSearch size={14} /> 导入本地文件夹
                </button>
                {!isTauri && <p className="dialog-footnote">浏览器预览里不能选文件夹，请在桌面端使用。</p>}
              </section>

          <section className="recognition-block mark-block">
            <div className="block-title">
              <Sparkles size={16} />
              <span>AI 识别打标</span>
              <span className="status-pill">{view.active ? (running ? "运行中" : view.paused ? "已暂停" : "已完成") : "待开始"}</span>
            </div>

            <div className="mark-controls">
              <label>
                <span>条数</span>
                <input
                  type="number"
                  min={1}
                  max={200}
                  value={count}
                  disabled={view.active}
                  onChange={(event) => setCount(Math.max(1, Number(event.target.value) || 1))}
                />
              </label>
              <label>
                <span>并发</span>
                <input
                  type="number"
                  min={1}
                  max={8}
                  value={concurrency}
                  disabled={view.active}
                  onChange={(event) => setConcurrency(Math.max(1, Math.min(8, Number(event.target.value) || 1)))}
                />
              </label>
              <label>
                <span>速度（仅预览模拟）</span>
                <select
                  value={speed}
                  disabled={view.active}
                  onChange={(event) => setSpeed(Number(event.target.value))}
                >
                  <option value={1}>1×</option>
                  <option value={2}>2×</option>
                  <option value={4}>4×</option>
                  <option value={8}>8×</option>
                </select>
              </label>
            </div>

            <div className="mark-progress">
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${progress}%` }} />
              </div>
              <div className="progress-meta">
                <span>{done} / {total} 张</span>
                <span>
                  {view.rate === null
                    ? "等待测速"
                    : view.rate <= 0
                      ? "速度计算中"
                      : `${view.rate.toFixed(2)} 张/秒`}
                </span>
                <span>剩余 {formatRemaining(total, done, view.rate)}</span>
              </div>
            </div>

            <div className="inflight-row">
              {[0, 1, 2].map((slot) => {
                const item = inFlight[slot];
                return (
                  <div className="inflight-card" key={slot}>
                    {item?.asset ? (
                      <img src={assetSrc(item.asset.thumb)} alt="正在识别" />
                    ) : (
                      <div className="inflight-empty">空闲</div>
                    )}
                    <span>槽位 {(item?.slot ?? slot) + 1}</span>
                  </div>
                );
              })}
              <div className="inflight-note">
                <span>正在处理</span>
                <strong>{inFlight.length}</strong>
                <span>路并发</span>
              </div>
            </div>

            <div className="dialog-actions">
              {primary}
              <button type="button" className="ghost-button" onClick={onClose}>
                后台运行
              </button>
            </div>
            <p className="dialog-footnote">
              这里的「开始识别」是界面预览；真实识别在详情页点「重新识别」，只跑当前这一张。
            </p>
          </section>
        </div>

        <section className="recognition-stats">
          <div className="stat-box">
            <span>已打标</span>
            <strong>{done}</strong>
            <CheckCircle2 size={15} />
          </div>
          <div className="stat-box">
            <span>待处理</span>
            <strong>{pending}</strong>
            <LoaderCircle size={15} />
          </div>
          <div className="stat-box danger">
            <span>失败</span>
            <strong>{failed}</strong>
            <AlertCircle size={15} />
          </div>
          <div className="stat-note">
            {finished
              ? "本轮已完成。事件仍保留在内存里，可回到整理视图看归位结果。"
              : "数值来自 /api/live/state · 关闭弹窗不会中断任务"}
          </div>
        </section>
      </section>
    </div>
  );
}

