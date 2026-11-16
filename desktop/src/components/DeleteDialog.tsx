import { Trash2 } from "lucide-react";
import { useDialogFocus, type GrowRect } from "../useDialogFocus";

type Props = {
  count: number;
  origin?: GrowRect | null;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

export function DeleteDialog({ count, origin = null, busy = false, onCancel, onConfirm }: Props) {
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
        <h2 className="delete-title">删除 {count} 张？</h2>
        <p className="delete-note">原图移到废纸篓，记录一并删除。</p>

        <div className="dialog-actions">
          <button type="button" className="ghost-button" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button type="button" className="danger-btn" onClick={onConfirm} disabled={busy}>
            <Trash2 size={14} /> {busy ? "删除中…" : "删除"}
          </button>
        </div>
      </div>
    </div>
  );
}