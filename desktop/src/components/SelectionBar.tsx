import { useState } from "react";
import { FolderPlus, Tag, X } from "lucide-react";

type Props = {
  count: number;
  busy: boolean;
  onTag: (tag: string) => void;
  onAlbum: (name: string) => void;
  onClear: () => void;
};

export function SelectionBar({ count, busy, onTag, onAlbum, onClear }: Props) {
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
      <input
        className="selection-input"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && trimmed) run(onAlbum);
          if (event.key === "Escape") onClear();
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
      <button type="button" className="selection-close" onClick={onClear} aria-label="取消选择">
        <X size={14} />
      </button>
    </div>
  );
}
