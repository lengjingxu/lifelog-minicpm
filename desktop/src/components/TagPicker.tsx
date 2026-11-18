import { useRef, useState } from "react";
import { LoaderCircle, Plus, Tag, X } from "lucide-react";
import clsx from "clsx";
import { useDialogFocus } from "../useDialogFocus";

type Props = {
  /** 已存在的标签与张数；新标签直接输入。 */
  tags: [string, number][];
  /** 这次要打标签的照片张数，用于文案。 */
  count: number;
  onApply: (tag: string) => Promise<void> | void;
  onCancel: () => void;
};

/** 批量「加标签」：列出现有标签，点一个直接应用；顶部可以建新标签（回车确认）。 */
export function TagPicker({ tags, count, onApply, onCancel }: Props) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useDialogFocus<HTMLDivElement>(onCancel, { focusContainer: false });

  const submit = async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(trimmed);
    setError(null);
    try {
      await onApply(trimmed);
    } catch (reason: unknown) {
      setError(String(reason).replace(/^Error:\s*/, ""));
      setBusy(null);
    }
  };

  const sorted = [...tags].sort((a, b) => b[1] - a[1]);

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onCancel}>
      <div
        ref={dialogRef}
        className="dialog delete-dialog tag-picker"
        role="dialog"
        aria-modal="true"
        aria-label="加标签"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 className="delete-title">加标签</h2>
        <p className="delete-note">给选中的 {count} 张加一个标签，点已有标签直接应用。</p>

        <div className="tag-picker-new">
          <input
            ref={inputRef}
            value={value}
            autoFocus
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void submit(value);
              }
            }}
            placeholder="输入新标签，回车确认"
            aria-label="新标签"
            disabled={Boolean(busy)}
          />
          <button type="button" className="primary-btn" onClick={() => void submit(value)} disabled={!value.trim() || Boolean(busy)}>
            {busy === value.trim() ? <LoaderCircle size={12} className="spin" /> : <Plus size={12} strokeWidth={2} />}
            新建并应用
          </button>
        </div>

        <div className="album-picker-list tag-picker-list" role="listbox" aria-label="已有标签">
          {sorted.length === 0 ? (
            <span className="album-picker-empty"><Tag size={14} /> 还没有自定义标签，在上面输入一个名字。</span>
          ) : (
            sorted.map(([name, n]) => (
              <button
                key={name}
                type="button"
                role="option"
                aria-selected={false}
                className={clsx("album-picker-item", busy === name && "busy")}
                disabled={Boolean(busy)}
                onClick={() => void submit(name)}
              >
                <Tag size={13} strokeWidth={1.8} />
                <span>{name}</span>
                <em>{n} 张</em>
                {busy === name && <LoaderCircle size={12} className="spin" />}
              </button>
            ))
          )}
        </div>

        {error && <p className="album-picker-error">{error}</p>}

        <div className="dialog-actions">
          <button type="button" className="ghost-button" onClick={onCancel} disabled={Boolean(busy)}>
            <X size={13} /> 取消
          </button>
        </div>
      </div>
    </div>
  );
}
