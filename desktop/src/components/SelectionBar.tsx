import { useState } from "react";
import { FolderMinus, FolderPlus, Tag, Trash2, X } from "lucide-react";

type Props = {
  count: number;
  busy: boolean;
  tagContext?: string | null;
  albumContext?: string | null;
  onTag: (tag: string) => void;
  onAlbum: (name: string) => void;
  onRemoveTag: (tag: string) => void;
  onRemoveAlbum: (name: string) => void;
  onClear: () => void;
  onDelete: () => void;
};

export function SelectionBar({
  count,
  busy,
  tagContext = null,
  albumContext = null,
  onTag,
  onAlbum,
  onRemoveTag,
  onRemoveAlbum,
  onClear,
  onDelete,
}: Props) {
  const [value, setValue] = useState("");
  const trimmed = value.trim();

  const run = (action: (text: string) => void) => {
    if (!trimmed) return;
    action(trimmed);
    setValue("");
  };

  return (
    <div className="selection-bar glass-surface" role="toolbar" aria-label="批量操作">
      <span className="selection-count">已选 {count} 张</span>
      {tagContext && (
        <button
          type="button"
          className="selection-remove"
          onClick={() => onRemoveTag(tagContext)}
          disabled={busy}
          title={`把选中的 ${count} 张从标签「${tagContext}」移除`}
        >
          <Tag size={13} /> 移除此标签：{tagContext}
        </button>
      )}
      {albumContext && (
        <button
          type="button"
          className="selection-remove"
          onClick={() => onRemoveAlbum(albumContext)}
          disabled={busy}
          title={`把选中的 ${count} 张从相册「${albumContext}」移出（不删文件）`}
        >
          <FolderMinus size={13} /> 移出此相册：{albumContext}
        </button>
      )}
      <input
        className="selection-input"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && trimmed) run(onAlbum);
          if (event.key === "Escape") {
            // 不要让全局 Escape 顺手把搜索条件也清了
            event.stopPropagation();
            onClear();
          }
        }}
        placeholder="输入标签或相册名"
        disabled={busy}
      />
      <button type="button" onClick={() => run(onTag)} disabled={!trimmed || busy}>
        <Tag size={13} /> 加标签
      </button>
      <button type="button" onClick={() => run(onAlbum)} disabled={!trimmed || busy}>
        <FolderPlus size={13} /> 加入相册
      </button>
      <button type="button" className="selection-delete" onClick={onDelete} disabled={busy}>
        <Trash2 size={13} /> 删除记录
      </button>
      <button type="button" className="selection-close" onClick={onClear} aria-label="取消选择">
        <X size={14} />
      </button>
    </div>
  );
}
