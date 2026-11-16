import { Trash2 } from "lucide-react";
import { useDialogFocus, type GrowRect } from "../useDialogFocus";

type Props = {
  count: number;
  /** 空间页结算时显示总大小，普通删除不传。 */
  bytes?: number | null;
  /** 指定标题/正文（详情页单张删除用）；不传时走批量文案。 */
  title?: string;
  note?: string;
  origin?: GrowRect | null;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

function sizeText(bytes: number): string {
  if (bytes < 1024 * 1024 * 1024) return Math.round(bytes / 1024 / 1024) + " MB";
  return (bytes / 1024 / 1024 / 1024).toFixed(1) + " GB";
}

export function DeleteDialog({ count, bytes = null, title, note, origin = null, busy = false, onCancel, onConfirm }: Props) {
  const dialogRef = useDialogFocus<HTMLDivElement>(onCancel, { growFrom: origin });

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onCancel}>
      <div
        ref={dialogRef}
        className="dialog delete-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="删除照片"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 className="delete-title">
          {title ?? (bytes != null ? "清理 " + count + " 个 · " + sizeText(bytes) : "删除 " + count + " 张")}
        </h2>
        <p className="delete-note">
          {note ?? (bytes != null ? "原图会移进废纸篓，库里的记录一并移除。" : "原图移到废纸篓，记录一并删除。")}
        </p>

        <div className="dialog-actions">
          <button type="button" className="ghost-button" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button type="button" className="danger-btn" onClick={onConfirm} disabled={busy}>
            <Trash2 size={14} /> {busy ? (bytes != null ? "清理中…" : "删除中…") : bytes != null ? "清理" : "删除"}
          </button>
        </div>
      </div>
    </div>
  );
}