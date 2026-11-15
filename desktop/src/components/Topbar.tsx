import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Clock, Command, Download, LayoutGrid, Moon, Search, Sun, X } from "lucide-react";
import clsx from "clsx";
import type { SortKey } from "../api";
import type { View } from "../utils";

const SORT_OPTIONS: { key: SortKey; label: string; icon: typeof Clock }[] = [
  { key: "taken_desc", label: "拍摄时间 · 新→旧", icon: ArrowDown },
  { key: "taken_asc", label: "拍摄时间 · 旧→新", icon: ArrowUp },
  { key: "size_desc", label: "文件大小 · 大→小", icon: ArrowDown },
  { key: "size_asc", label: "文件大小 · 小→大", icon: ArrowUp },
];

type Density = "comfort" | "compact";

type Props = {
  title: string;
  subtitle: string;
  searchValue: string;
  onSearchOpen: (rect: DOMRect) => void;
  onSearchClear: () => void;
  density: Density;
  onDensity: (density: Density) => void;
  sort: SortKey;
  onSort: (sort: SortKey) => void;
  view: View;
  onView: (view: View) => void;
  minimal?: boolean;
  theme?: "dark" | "light";
  onTheme?: (theme: "dark" | "light") => void;
  onExport?: () => void;
};

export function Topbar({
  title,
  subtitle,
  searchValue,
  onSearchOpen,
  onSearchClear,
  density,
  onDensity,
  sort,
  onSort,
  view,
  onView,
  minimal = false,
  theme = "dark",
  onTheme,
  onExport,
}: Props) {
  return (
    <header className="toolbar">
      <div className="title-block">
        <div className="title-main" key={`t-${title}`}>{title}</div>
        <div className="title-sub" key={`s-${subtitle}`}>{subtitle}</div>
      </div>

      <div className="toolbar-spacer" />

      {!minimal && (
        <>
      <div className="search glass-control">
        <Search size={14} strokeWidth={1.8} />
        <button
          type="button"
          className={clsx("search-trigger", !searchValue && "empty")}
          onClick={(event) => {
            const field = event.currentTarget.closest<HTMLElement>(".search") ?? event.currentTarget;
            onSearchOpen(field.getBoundingClientRect());
          }}
          aria-label="搜索照片（⌘K）"
          title="搜索与跳转 ⌘K"
        >
          {searchValue || "搜索描述、标签、地点或文字…"}
        </button>
        {searchValue ? (
          <button type="button" className="search-clear" onClick={onSearchClear} aria-label="清除搜索">
            <X size={12} strokeWidth={2} />
          </button>
        ) : (
          <kbd className="kbd">
            <Command size={10} strokeWidth={2} />K
          </kbd>
        )}
      </div>

      {onTheme && (
        <button
          type="button"
          className="theme-toggle"
          onClick={() => onTheme(theme === "dark" ? "light" : "dark")}
          aria-label={theme === "dark" ? "切换到亮色" : "切换到暗色"}
          title={theme === "dark" ? "切换到亮色" : "切换到暗色"}
        >
          {theme === "dark" ? <Sun size={15} strokeWidth={1.8} /> : <Moon size={15} strokeWidth={1.8} />}
        </button>
      )}
      <div className="toolbar-divider" />

      <div className="view-switch" role="group" aria-label="视图切换">
        <span className="view-switch-indicator" data-pos={view === "timeline" ? 1 : 0} aria-hidden="true" />
        <button
          type="button"
          className={clsx(view === "library" && "active")}
          onClick={() => onView("library")}
          aria-label="网格视图"
          aria-pressed={view === "library"}
          title="网格 ⌘1"
        >
          <LayoutGrid size={14} strokeWidth={1.8} />
        </button>
        <button
          type="button"
          className={clsx(view === "timeline" && "active")}
          onClick={() => onView("timeline")}
          aria-label="时间线视图"
          aria-pressed={view === "timeline"}
          title="时间线 ⌘2"
        >
          <Clock size={14} strokeWidth={1.8} />
        </button>
      </div>

      {onExport && (
        <button
          type="button"
          className="icon-button"
          onClick={onExport}
          aria-label="导出当前范围"
          title="导出当前范围（选中优先）"
        >
          <Download size={15} strokeWidth={1.8} />
        </button>
      )}
      <SortButton sort={sort} onSort={onSort} />
      <div className="density-switch" role="group" aria-label="网格密度">
        <button
          type="button"
          className={clsx(density === "comfort" && "active")}
          onClick={() => onDensity("comfort")}
          aria-label="舒适 6 列"
          aria-pressed={density === "comfort"}
          title="舒适 · 6 列（⌘+）"
        >
          6
        </button>
        <button
          type="button"
          className={clsx(density === "compact" && "active")}
          onClick={() => onDensity("compact")}
          aria-label="紧凑 8 列"
          aria-pressed={density === "compact"}
          title="紧凑 · 8 列（⌘-）"
        >
          8
        </button>
      </div>
        </>
      )}
    </header>
  );
}


function SortButton({ sort, onSort }: { sort: SortKey; onSort: (sort: SortKey) => void }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const current = SORT_OPTIONS.find((option) => option.key === sort) ?? SORT_OPTIONS[0];
  const Icon = current.icon;

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="sort-box" ref={boxRef}>
      <button
        type="button"
        className={clsx("sort-button glass-control", open && "open")}
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`排序：${current.label}`}
        title={current.label}
      >
        <Icon size={13} strokeWidth={1.9} />
        <span>{sort.startsWith("size") ? "大小" : "时间"}</span>
      </button>
      {open && (
        <div className="sort-menu glass-surface" role="listbox" aria-label="排序方式">
          {SORT_OPTIONS.map((option) => {
            const OptionIcon = option.icon;
            return (
              <button
                key={option.key}
                type="button"
                role="option"
                aria-selected={option.key === sort}
                className={clsx("sort-item", option.key === sort && "active")}
                onClick={() => {
                  setOpen(false);
                  onSort(option.key);
                }}
              >
                <OptionIcon size={13} strokeWidth={1.9} />
                <span>{option.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
