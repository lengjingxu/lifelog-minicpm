import { useState } from "react";
import { Trash2 } from "lucide-react";
import { useDialogFocus } from "../useDialogFocus";

type Props = {
  count: number;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

export function DeleteDialog({ count, busy = false, onCancel, onConfirm }: Props) {
  const [confirmed, setConfirmed] = useState(false);
  const dialogRef = useDialogFocus<HTMLDivElement>(onCancel);
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onCancel}>
      <div
        ref={dialogRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label="移除记录"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog-head">
          <div>
            <h2>移除 {count} 条记录</h2>
            <p>只移除记录，不动磁盘文件</p>
          </div>
        </header>

        <div className="dialog-body">
          <p className="dialog-text">
            将从库中移除这 {count} 张照片的记录（含 AI 描述、用户标签、相册关联）。
          </p>
          <p className="dialog-text dim">
            只移除记录，不动磁盘文件 —— 原图仍然留在相册里；重新扫描目录就能再登记回来。这一步没有撤销入口。
          </p>
        </div>

        <label className="confirm-row">
          <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
          <span>我知道原图不会被删除，但记录移除后无法在此界面撤销</span>
        </label>

        <div className="dialog-actions">
          <button type="button" className="ghost-button" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className="danger-btn"
            disabled={!confirmed || busy}
            onClick={onConfirm}
          >
            <Trash2 size={14} /> {busy ? "移除中…" : "移除记录"}
          </button>
        </div>
      </div>
    </div>
  );
}
