import { CloudDownload, RefreshCw } from "lucide-react";
import { useDialogFocus } from "../useDialogFocus";

export type ImportPlan = {
  listed: number;
  new: number;
  existing: number;
  bytes: number;
};

export type ImportProgress = {
  stage?: string;
  done?: number;
  total?: number;
  message?: string;
  code?: string;
};

type Props = {
  plan: ImportPlan | null;
  progress: ImportProgress | null;
  busy: boolean;
  authError: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  onRetryAuth: () => void;
};

function gb(bytes: number): string {
  return bytes >= 1e9
    ? (bytes / 1e9).toFixed(1) + " GB"
    : Math.max(1, Math.round(bytes / 1e6)) + " MB";
}

export function ImportDialog({
  plan,
  progress,
  busy,
  authError,
  onCancel,
  onConfirm,
  onRetryAuth,
}: Props) {
  const canClose = !busy || authError;
  const dialogRef = useDialogFocus<HTMLDivElement>(() => {
    if (canClose) onCancel();
  });
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={busy ? undefined : onCancel}>
      <div
        ref={dialogRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label="导入小米相册"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog-head">
          <div>
            <h2>导入小米相册</h2>
            <p>云端只读，只下载到本地</p>
          </div>
        </header>

        <div className="dialog-body">
          {authError ? (
            <>
              <p className="dialog-text">小米云登录态已失效。</p>
              <p className="dialog-text dim">
                请打开小米云服务 App 重新登录，然后点「重新检测登录态」再试。已经下好的照片不会重复下载。
              </p>
            </>
          ) : progress ? (
            <>
              <p className="dialog-text">{progress.message ?? "正在下载…"}</p>
              {progress.total ? (
                <p className="dialog-text dim">
                  已完成 {progress.done ?? 0} / {progress.total} 张
                </p>
              ) : null}
            </>
          ) : plan ? (
            <>
              <p className="dialog-text">
                区间内共 {plan.listed} 张：将新增 <b>{plan.new}</b> 张，本地已有 <b>{plan.existing}</b> 张。
              </p>
              <p className="dialog-text dim">
                需要下载约 {gb(plan.bytes)}。中断后可续传，已下载的不会重来。
              </p>
            </>
          ) : null}
        </div>

        <div className="dialog-actions">
          <button type="button" className="ghost-button" onClick={onCancel} disabled={busy && !authError}>
            取消
          </button>
          {authError ? (
            <button type="button" className="primary-btn" onClick={onRetryAuth} disabled={busy}>
              <RefreshCw size={14} /> 重新检测登录态
            </button>
          ) : (
            <button type="button" className="primary-btn" onClick={onConfirm} disabled={busy || !plan}>
              <CloudDownload size={14} /> {busy ? "导入中…" : "开始下载"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
