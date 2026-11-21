import { useCallback, useEffect, useState } from "react";
import { ArchiveRestore, LoaderCircle, RotateCcw, Trash2, X } from "lucide-react";
import { assetSrc, emptyTrash, restoreRecords, trashList, type TrashItem } from "../api";
import { formatBytes, timeLabel } from "../utils";

type Props = {
  onRestored: (ids: string[]) => void;
  onPurged: (ids: string[]) => void;
  onError: (message: string) => void;
  onToast: (message: string) => void;
};

/** 最近删除：软删的照片都在这里，30 天内可还原，清空时才真正移进废纸篓。 */
export function TrashView({ onRestored, onPurged, onError, onToast }: Props) {
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const [already, setAlready] = useState(0);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirmEmpty, setConfirmEmpty] = useState(false);

  const load = useCallback(() => {
    trashList({ limit: 2000 })
      .then((result) => {
        setItems(result.items);
        setAlready(result.retention_days);
      })
      .catch((reason: unknown) => {
        setItems([]);
        onError("读取最近删除失败：" + (reason instanceof Error ? reason.message : String(reason)));
      });
  }, [onError]);

  useEffect(load, [load]);

  const total = items?.length ?? 0;
  const bytes = (items ?? []).reduce((sum, item) => sum + (item.size ?? 0), 0);

  const toggle = (id: string) => {
    setPicked((previous) =>
      previous.includes(id) ? previous.filter((item) => item !== id) : [...previous, id],
    );
  };

  const restore = async (ids: string[]) => {
    if (!ids.length || busy) return;
    setBusy(true);
    try {
      const result = await restoreRecords(ids);
      onToast(`已还原 ${result.restored} 张`);
      onRestored(ids);
      setPicked([]);
      load();
    } catch (reason: unknown) {
      onError("还原失败：" + (reason instanceof Error ? reason.message : String(reason)));
    } finally {
      setBusy(false);
    }
  };

  const purge = async (ids?: string[]) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await emptyTrash(ids);
      const count = ids?.length ?? total;
      onToast(
        `已清空 ${count} 张，${result.files?.trashed ?? 0} 个文件移进废纸篓`,
      );
      onPurged(ids ?? (items ?? []).map((item) => item.id));
      setPicked([]);
      setConfirmEmpty(false);
      load();
    } catch (reason: unknown) {
      // 失败必须让用户看见：文件可能移不动（权限/外置盘）。
      onError("清空回收站失败：" + (reason instanceof Error ? reason.message : String(reason)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="trash-view">
      <div className="trash-head">
        <div>
          <h2>最近删除</h2>
          <p>
            {total > 0 ? `${total} 张 · ${formatBytes(bytes)}` : "回收站是空的"}
            <span className="trash-retention"> · {already} 天后自动清空</span>
          </p>
        </div>
        <div className="trash-actions">
          {picked.length > 0 && (
            <button
              type="button"
              className="ghost-button"
              disabled={busy}
              onClick={() => void restore(picked)}
            >
              <RotateCcw size={13} strokeWidth={1.8} /> 还原 {picked.length} 张
            </button>
          )}
          {total > 0 && (
            <button
              type="button"
              className="ghost-button danger-text"
              disabled={busy}
              onClick={() => setConfirmEmpty(true)}
            >
              <Trash2 size={13} strokeWidth={1.8} /> 清空回收站
            </button>
          )}
        </div>
      </div>

      {items === null ? (
        <div className="trash-empty-state">
          <LoaderCircle size={16} className="spin" /> 正在读取…
        </div>
      ) : total === 0 ? (
        <div className="trash-empty-state">
          <ArchiveRestore size={26} strokeWidth={1.5} />
          <p>删掉的照片会先放在这里，30 天内都能还原。</p>
        </div>
      ) : (
        <div className="trash-grid">
          {items.map((item) => (
            <div
              key={item.id}
              className={picked.includes(item.id) ? "trash-card picked" : "trash-card"}
              data-asset-id={item.id}
            >
              <button
                type="button"
                className="trash-thumb"
                onClick={() => toggle(item.id)}
                aria-pressed={picked.includes(item.id)}
                aria-label={`选择 ${item.path.split("/").pop()}`}
              >
                {/* 回收站里优先用缩略图：原图可能在外置盘，读取太慢。 */}
                <img src={item.thumb || assetSrc(item.path)} alt="" draggable={false} loading="lazy" />
                <span className="trash-meta">
                  {timeLabel(item.taken_at)}
                  {item.size ? ` · ${formatBytes(item.size)}` : ""}
                </span>
              </button>
              <button
                type="button"
                className="trash-restore"
                onClick={() => void restore([item.id])}
                disabled={busy}
              >
                <RotateCcw size={12} strokeWidth={1.9} /> 还原
              </button>
              <em className="trash-when">{item.deleted_at.replace("T", " ").slice(0, 16)}</em>
            </div>
          ))}
        </div>
      )}

      {confirmEmpty && (
        <div className="dialog-backdrop" role="presentation" onMouseDown={() => setConfirmEmpty(false)}>
          <div
            className="dialog delete-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="清空回收站"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2 className="delete-title">
              清空 {picked.length || total} 张？
            </h2>
            <p className="delete-note">
              这一步会把原图移进系统废纸篓并删除记录，之后不能在应用里还原。
            </p>
            <div className="dialog-actions">
              <button type="button" className="ghost-button" onClick={() => setConfirmEmpty(false)} disabled={busy}>
                <X size={13} /> 取消
              </button>
              <button
                type="button"
                className="danger-btn"
                onClick={() => void purge(picked.length ? picked : undefined)}
                disabled={busy}
              >
                <Trash2 size={14} /> {busy ? "清空中…" : "清空"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
