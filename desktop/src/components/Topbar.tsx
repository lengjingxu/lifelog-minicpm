import type { RefObject } from "react";
import { Clock, Command, LayoutGrid, Search, X } from "lucide-react";
import clsx from "clsx";
import type { View } from "../utils";

type Density = "comfort" | "compact";

type Props = {
  title: string;
  subtitle: string;
  searchValue: string;
  onSearchChange: (value: string) => void;
  onSearchClear: () => void;
  searchRef: RefObject<HTMLInputElement | null>;
  density: Density;
  onDensity: (density: Density) => void;
  view: View;
  onView: (view: View) => void;
};

export function Topbar({
  title,
  subtitle,
  searchValue,
  onSearchChange,
  onSearchClear,
  searchRef,
  density,
  onDensity,
  view,
  onView,
}: Props) {
  return (
    <header className="toolbar">
      <div className="title-block">
        <div className="title-main">{title}</div>
        <div className="title-sub">{subtitle}</div>
      </div>

      <div className="toolbar-spacer" />

      <div className="search">
        <Search size={14} strokeWidth={1.8} />
        <input
          ref={searchRef}
          value={searchValue}
          onChange={(event) => onSearchChange(event.currentTarget.value)}
          placeholder="搜索描述、标签、地点或文字…"
          aria-label="搜索照片"
          spellCheck={false}
        />
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

      <div className="toolbar-divider" />

      <div className="view-switch" aria-label="视图切换">
        <button
          type="button"
          className={clsx(view === "library" && "active")}
          onClick={() => onView("library")}
          title="网格 ⌘1"
        >
          <LayoutGrid size={14} strokeWidth={1.8} />
        </button>
        <button
          type="button"
          className={clsx(view === "timeline" && "active")}
          onClick={() => onView("timeline")}
          title="时间线 ⌘2"
        >
          <Clock size={14} strokeWidth={1.8} />
        </button>
      </div>

      <div className="density-switch" aria-label="网格密度">
        <button
          type="button"
          className={clsx(density === "comfort" && "active")}
          onClick={() => onDensity("comfort")}
          title="舒适 · 6 列（⌘+）"
        >
          6
        </button>
        <button
          type="button"
          className={clsx(density === "compact" && "active")}
          onClick={() => onDensity("compact")}
          title="紧凑 · 8 列（⌘-）"
        >
          8
        </button>
      </div>
    </header>
  );
}
