import { FolderLock } from "lucide-react";
import { useDialogFocus } from "../useDialogFocus";

type Props = {
  roots: string[];
  busy?: boolean;
  onOpenSettings: () => void;
  onRecheck: () => void;
  onDismiss: () => void;
};

export function AccessDialog({ roots, busy = false, onOpenSettings, onRecheck, onDismiss }: Props) {
  const dialogRef = useDialogFocus<HTMLDivElement>(onDismiss);

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onDismiss}>
      <div
        ref={dialogRef}
        className="dialog delete-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="照片目录没有访问权限"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 className="delete-title">照片目录没有访问权限</h2>
        <p className="delete-note">{roots.join("、")}</p>

        <div className="dialog-actions">
          <button type="button" className="ghost-button" onClick={onDismiss} disabled={busy}>
            稍后
          </button>
          <button type="button" className="ghost-button" onClick={onRecheck} disabled={busy}>
            已授权，重新检查
          </button>
          <button type="button" className="danger-btn" onClick={onOpenSettings}>
            <FolderLock size={14} /> 打开系统设置
          </button>
        </div>
      </div>
    </div>
  );
}
