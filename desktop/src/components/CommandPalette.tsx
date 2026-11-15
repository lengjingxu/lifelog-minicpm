import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { LucideIcon } from "lucide-react";
import { Search } from "lucide-react";
import { DURATION, EASE, reducedMotion } from "../motion";
import { useDialogFocus } from "../useDialogFocus";

export type PaletteItem = {
  id: string;
  title: string;
  subtitle?: string;
  icon: LucideIcon;
  /** 右侧的键帽，例如 ⌘1 */
  keycap?: string;
  run: () => void;
};

export type PaletteSection = { label: string; items: PaletteItem[] };

type Rect = { x: number; y: number; width: number; height: number };

type Props = {
  open: boolean;
  /** 打开它的那个字段的矩形：面板从它的框里长出来 */
  origin?: Rect | null;
  query: string;
  onQueryChange: (value: string) => void;
  sections: PaletteSection[];
  onClose: () => void;
};

export function CommandPalette({ open, origin, query, onQueryChange, sections, onClose }: Props) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [closing, setClosing] = useState(false);

  const requestClose = useCallback(() => {
    if (closing) return;
    if (reducedMotion() || !origin || !panelRef.current) {
      onClose();
      return;
    }
    setClosing(true);
  }, [closing, onClose, origin]);

  const dialogRef = useDialogFocus<HTMLDivElement>(requestClose, { enabled: open });

  // 进：从触发字段的框长成居中卡片；出：原路缩回去。
  useEffect(() => {
    const el = panelRef.current;
    if (!open || !el || !origin || reducedMotion()) return;
    const box = el.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const sx = origin.width / box.width;
    const sy = origin.height / box.height;
    const dx = origin.x + origin.width / 2 - (box.left + box.width / 2);
    const dy = origin.y + origin.height / 2 - (box.top + box.height / 2);
    el.animate(
      [
        { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, borderRadius: "10px", opacity: 0.85 },
        { transform: "none", borderRadius: "26px", opacity: 1 },
      ],
      { duration: 260, easing: EASE.outStrong },
    );
    contentRef.current?.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 150,
      delay: 110,
      easing: EASE.out,
      fill: "backwards",
    });
    // 只在打开时按当时的字段位置跑一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!closing) return;
    const el = panelRef.current;
    if (!el || !origin) {
      onClose();
      return;
    }
    const box = el.getBoundingClientRect();
    const sx = origin.width / box.width;
    const sy = origin.height / box.height;
    const dx = origin.x + origin.width / 2 - (box.left + box.width / 2);
    const dy = origin.y + origin.height / 2 - (box.top + box.height / 2);
    const animation = el.animate(
      [
        { transform: "none", borderRadius: "26px", opacity: 1 },
        { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, borderRadius: "10px", opacity: 0 },
      ],
      { duration: DURATION.sm, easing: EASE.inOut, fill: "forwards" },
    );
    animation.onfinish = () => onClose();
  }, [closing, origin, onClose]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [active, setActive] = useState(0);

  // 扁平索引：键盘上下移动跨越分组
  const flat = useMemo(() => sections.flatMap((section) => section.items), [sections]);

  useEffect(() => {
    if (open) setActive(0);
  }, [open, query]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(`[data-palette-index="${active}"]`);
    node?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const runAt = (index: number) => {
    const item = flat[index];
    if (!item) return;
    onClose();
    item.run();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((previous) => (flat.length ? (previous + 1) % flat.length : 0));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((previous) => (flat.length ? (previous - 1 + flat.length) % flat.length : 0));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      runAt(active);
    }
  };

  if (!open) return null;

  let cursor = -1;
  return (
    <div className="palette-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        ref={(node) => { dialogRef.current = node; panelRef.current = node; }}
        className="palette glass-surface"
        role="dialog"
        aria-modal="true"
        aria-label="搜索与跳转"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="palette-input">
          <Search size={17} strokeWidth={1.7} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => onQueryChange(event.currentTarget.value)}
            placeholder="搜索照片，或跳转到任意位置"
            aria-label="搜索照片或跳转"
            spellCheck={false}
          />
        </div>

        <div ref={contentRef} className="palette-body">
        <div className="palette-list" ref={listRef} role="listbox" aria-label="结果">
          {flat.length === 0 ? (
            <div className="palette-empty">没有匹配的内容</div>
          ) : (
            sections.map((section) => (
              <div key={section.label}>
                <div className="palette-group">{section.label}</div>
                {section.items.map((item) => {
                  cursor += 1;
                  const index = cursor;
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      role="option"
                      aria-selected={index === active}
                      data-palette-index={index}
                      className={index === active ? "palette-row active" : "palette-row"}
                      onMouseMove={() => setActive(index)}
                      onClick={() => runAt(index)}
                    >
                      <span className="palette-tile">
                        <Icon size={15} strokeWidth={1.8} />
                      </span>
                      <span className="palette-text">
                        <span className="palette-title">{item.title}</span>
                        {item.subtitle ? <span className="palette-sub">{item.subtitle}</span> : null}
                      </span>
                      {item.keycap ? <span className="palette-key">{item.keycap}</span> : null}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="palette-foot">
          <span>↑↓ 选择 · ⏎ 打开</span>
          <span>Esc 关闭</span>
        </div>
        </div>
      </div>
    </div>
  );
}