import { FolderSearch, LoaderCircle, RefreshCw, X } from "lucide-react";

export type FolderProgress = {
  stage: "ingest" | "ingest-done" | "thumbs" | "done";
  seen: number;
  added: number;
  skipped: number;
  /** 缩略图阶段：done / total / rate / eta（秒）。 */
  thumbs?: { done: number; total: number; rate: number; eta: number | null };
};

export type FolderFailure = { message: string };

function number(value: number): string {
  return value.toLocaleString();
}

/** 「正在导入照片」整页视图：替换空状态，扫描 / 缩略图两段进度，可收起到右下角。 */
export function ImportProgressView({
  progress,
  busy,
  onBackground,
  onCancel,
  onRetry,
  onPickAnother,
  failed = false,
}: {
  progress: FolderProgress;
  busy: boolean;
  onBackground: () => void;
  onCancel: () => void;
  onRetry: () => void;
  onPickAnother: () => void;
  failed?: boolean;
}) {
  const thumbs = progress.thumbs;
  const scanning = progress.stage === "ingest";
  const title = scanning
    ? "正在导入照片"
    : progress.stage === "done"
      ? "导入完成"
      : "扫描完成，正在生成缩略图";

  const percent = thumbs && thumbs.total > 0 ? Math.min(100, (thumbs.done / thumbs.total) * 100) : 0;

  return (
    <div className="import-progress">
      <div className="import-progress-card">
        <div className="import-progress-head">
          <span className="import-progress-icon">
            {busy ? <LoaderCircle size={18} className="spin" /> : <FolderSearch size={18} strokeWidth={1.7} />}
          </span>
          <div>
            <h2>{title}</h2>
            <p className="import-progress-sub">
              {scanning ? "正在扫描文件夹" : "原图已入库，缩略图随后补齐"}
            </p>
          </div>
        </div>

        <dl className="import-progress-stats">
          <div>
            <dt>已扫描</dt>
            <dd>{number(progress.seen)}</dd>
          </div>
          <div>
            <dt>新增</dt>
            <dd>{number(progress.added)}</dd>
          </div>
          <div>
            <dt>跳过</dt>
            <dd>{number(progress.skipped)}</dd>
          </div>
        </dl>

        <div className="import-progress-track" data-indeterminate={scanning || !thumbs ? "true" : "false"}>
          {thumbs && !scanning ? (
            <span className="import-progress-fill" style={{ width: `${percent}%` }} />
          ) : (
            <span className="import-progress-pulse" />
          )}
        </div>

        <p className="import-progress-meta">
          {thumbs && !scanning
            ? `${number(thumbs.done)} / ${number(thumbs.total)} 张 · ${thumbs.rate.toFixed(1)} 张/秒${
                thumbs.eta != null ? ` · 剩余 ${thumbs.eta}s` : ""
              }`
            : scanning
              ? "总数未知，正在逐个数…"
              : "正在准备缩略图…"}
        </p>

        {/* 失败时也保留「在后台继续」：失败只是这一节点的结果，不该劫持整个视图。 */}
        <div className="import-progress-actions">
          {failed && (
            <>
              <button type="button" className="ghost-button" onClick={onRetry} disabled={busy}>
                <RefreshCw size={12} strokeWidth={1.9} /> 重试
              </button>
              <button type="button" className="ghost-button" onClick={onPickAnother} disabled={busy}>
                <FolderSearch size={12} strokeWidth={1.9} /> 换个文件夹
              </button>
            </>
          )}
          <button type="button" className="ghost-button" onClick={onBackground}>
            在后台继续
          </button>
          <button type="button" className="ghost-button" onClick={onCancel}>
            <X size={12} strokeWidth={1.9} /> 取消
          </button>
        </div>
      </div>
    </div>
  );
}

/** 收起到右下角的细进度条。 */
export function ImportMiniBar({
  progress,
  failure,
  onExpand,
  onDismiss,
}: {
  progress: FolderProgress;
  failure: FolderFailure | null;
  onExpand: () => void;
  onDismiss: () => void;
}) {
  const thumbs = progress.thumbs;
  const percent = thumbs && thumbs.total > 0 ? Math.min(100, (thumbs.done / thumbs.total) * 100) : 0;
  return (
    <div className="import-mini" role="status">
      <button type="button" className="import-mini-main" onClick={onExpand}>
        <span className="import-mini-copy">
          {failure
            ? "导入失败"
            : progress.stage === "thumbs" && thumbs
              ? `正在生成缩略图 ${number(thumbs.done)} / ${number(thumbs.total)}`
              : `正在导入 · 已扫 ${number(progress.seen)} 个`}
        </span>
        <span className="import-mini-track">
          <span
            className="import-mini-fill"
            style={{ width: thumbs && progress.stage === "thumbs" ? `${percent}%` : "38%" }}
            data-indeterminate={String(!(thumbs && progress.stage === "thumbs"))}
          />
        </span>
      </button>
      <button type="button" className="import-mini-close" onClick={onDismiss} aria-label="收起导入进度">
        <X size={11} strokeWidth={2} />
      </button>
    </div>
  );
}

