import { useLayoutEffect, useRef, useState } from "react";
import { FolderMinus, FolderPlus, Tag, Trash2, X } from "lucide-react";

type Props = {
  count: number;
  /** 让它出现的那张卡片的矩形：条从卡片那里长出来 */
  origin?: { x: number; y: number; width: number; height: number } | null;
  busy: boolean;
  tagContext?: string | null;
  albumContext?: string | null;
  onTag: (tag: string) => void;
  onAlbum: (name: string) => void;
  onRemoveTag: (tag: string) => void;
  onRemoveAlbum: (name: string) => void;
  onClear: () => void;
  onDelete: (rect: DOMRect) => void;
};

export function SelectionBar({
  count,
  origin = null,
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
  const barRef = useRef<HTMLDivElement | null>(null);

  // 第一次选中时，条从那张照片的下沿长出来；之后只是内容变化。
  useLayoutEffect(() => {
    const el = barRef.current;
    if (!el || !origin) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const box = el.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const sx = Math.min(1, Math.max(0.25, origin.width / box.width));
    const dx = origin.x + origin.width / 2 - (box.left + box.width / 2);
    const dy = origin.y + origin.height / 2 - (box.top + box.height / 2);
    el.animate(
      [
        { transform: `translate(${dx}px, ${dy}px) scale(${sx}, 0.55)`, opacity: 0, borderRadius: "10px" },
        { transform: "none", opacity: 1, borderRadius: "16px" },
      ],
      { duration: 280, easing: "cubic-bezier(.22, 1, .36, 1)" },
    );
    // 只在首次出现时跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = (action: (text: string) => void) => {
    if (!trimmed) return;
    action(trimmed);
    setValue("");
  };

  return (
    <div ref={barRef} className="selection-bar glass-surface" role="toolbar" aria-label="批量操作">
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
      <button
        type="button"
        className="selection-delete"
        onClick={(event) => onDelete(event.currentTarget.getBoundingClientRect())}
        disabled={busy}
      >
        <Trash2 size={13} /> 删除记录
      </button>
      <button type="button" className="selection-close" onClick={onClear} aria-label="取消选择">
        <X size={14} />
      </button>
    </div>
  );
}
