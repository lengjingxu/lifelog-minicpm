import {
  Clock,
  Database,
  Images,
  MapPin,
  Search,
  Settings,
  Sparkles,
  Tags,
  Users,
} from "lucide-react";
import clsx from "clsx";
import type { Facets, Health, LiveStatus, Stats } from "../api";
import { useLayoutEffect, useRef } from "react";
import { formatBytes, type View } from "../utils";

type Props = {
  stats: Stats | null;
  facets: Facets | null;
  healthInfo: Health | null;
  view: View;
  activeTags: string[];
  activeAlbum: string | null;
  onAlbum: (name: string) => void;
  activePerson: string | null;
  activePlace: string | null;
  placeTotal: number;
  onNavigate: (view: View) => void;
  onTag: (tag: string) => void;
  onPerson: (person: string) => void;
  onPlace: (place: string) => void;
  onSearch: () => void;
  liveStatus: { status: LiveStatus; done: number; total: number; rate: number | null; paused: boolean } | null;
  onRecognition: (rect?: DOMRect) => void;
  onSettings: () => void;
};

const NAV = [
  { id: "library" as const, label: "全部照片", icon: Images },
  { id: "timeline" as const, label: "时间线", icon: Clock },
  { id: "tags" as const, label: "标签", icon: Tags },
  { id: "people" as const, label: "人物", icon: Users },
  { id: "places" as const, label: "地点", icon: MapPin },
  { id: "organize" as const, label: "整理视图", icon: Sparkles },
];

export function Sidebar({
  stats,
  facets,
  healthInfo,
  view,
  activeTags,
  activeAlbum,
  onAlbum,
  activePerson,
  activePlace,
  placeTotal,
  onNavigate,
  onTag,
  onPerson,
  onPlace,
  onSearch,
  liveStatus,
  onRecognition,
  onSettings,
}: Props) {
  const navRef = useRef<HTMLDivElement | null>(null);
  const indicatorRef = useRef<HTMLSpanElement | null>(null);
  const firstRun = useRef(true);

  useLayoutEffect(() => {
    const list = navRef.current;
    const indicator = indicatorRef.current;
    if (!list || !indicator) return;
    const active = list.querySelector<HTMLElement>(".nav-item.active");
    if (!active) {
      indicator.style.opacity = "0";
      return;
    }
    indicator.style.transition = firstRun.current
      ? "opacity 160ms linear"
      : "transform 240ms cubic-bezier(.32,.72,0,1), height 240ms cubic-bezier(.32,.72,0,1), opacity 160ms linear";
    firstRun.current = false;
    indicator.style.opacity = "1";
    indicator.style.height = `${active.offsetHeight}px`;
    indicator.style.transform = `translateY(${active.offsetTop}px)`;
  }, [view]);

  const tags = facets?.tags ?? [];
  const albums = facets?.albums ?? [];
  const people = (facets?.people ?? []).filter(([name]) => name !== "无" && name !== "未知").slice(0, 3);

  return (
    <aside className="sidebar">
      <div className="drag-strip" />
      <div className="brand">
        <div className="brand-mark">拾</div>
        <div>
          <div className="brand-name">拾光</div>
          <div className="brand-sub">Local Library</div>
        </div>
      </div>

      <button type="button" className="sidebar-search" onClick={onSearch}>
        <Search size={13} strokeWidth={1.8} />
        <span>搜索照片</span>
        <kbd>⌘K</kbd>
      </button>

      <div className="sidebar-scroll">
        <div className="nav-group-label">资料库</div>
        <div className="nav-list" ref={navRef}>
          <span className="nav-indicator" ref={indicatorRef} aria-hidden="true" />
        {NAV.map((item) => {
          const Icon = item.icon;
          const count =
            item.id === "library" || item.id === "timeline"
              ? stats?.assets
              : item.id === "tags"
                ? tags.length
                : item.id === "people"
                  ? facets?.people.length
                  : item.id === "places"
                    ? placeTotal || undefined
                    : undefined;
          return (
            <button
              key={item.id}
              type="button"
              className={clsx("nav-item", view === item.id && "active")}
              onClick={() => onNavigate(item.id)}
              aria-current={view === item.id ? "page" : undefined}
            >
              <Icon size={15} strokeWidth={1.7} />
              <span>{item.label}</span>
              {count ? <span className="count">{count}</span> : null}
              <span className="dot" />
            </button>
          );
        })}
        </div>

        <div className="nav-group-label">相册</div>
        {albums.length === 0 ? (
          <div className="sidebar-empty">选中照片后可以加入相册</div>
        ) : (
          albums.map(([name, count]) => (
            <button
              key={name}
              type="button"
              className={clsx("tag-pill", activeAlbum === name && "active")}
              onClick={() => onAlbum(name)}
            >
              <span className="tag-dot place" />
              <span className="tag-name">{name}</span>
              <span className="count">{count}</span>
            </button>
          ))
        )}

        <div className="nav-group-label">标签</div>
        {tags.length === 0 ? (
          <div className="sidebar-empty">还没有 AI 标签</div>
        ) : (
          tags.map(([tag, count]) => (
            <button
              key={tag}
              type="button"
              className={clsx("tag-pill", activeTags.includes(tag) && "active")}
              onClick={() => onTag(tag)}
            >
              <span className="tag-dot" />
              <span className="tag-name">{tag}</span>
              <span className="count">{count}</span>
            </button>
          ))
        )}

        {people.length > 0 && (
          <>
            <div className="nav-group-label">人物</div>
            {people.map(([person, count]) => (
              <button
                key={person}
                type="button"
                className={clsx("tag-pill", activePerson === person && "active")}
                onClick={() => onPerson(person)}
              >
                <span className="tag-dot person" />
                <span className="tag-name">{person}</span>
                <span className="count">{count}</span>
              </button>
            ))}
          </>
        )}

        {activePlace && (
          <>
            <div className="nav-group-label">地点</div>
            <button type="button" className="tag-pill active" onClick={() => onPlace(activePlace)}>
              <span className="tag-dot place" />
              <span className="tag-name">{activePlace}</span>
            </button>
          </>
        )}
      </div>

      <div className="sidebar-foot">
        {liveStatus && liveStatus.status !== "idle" && (
          <button type="button" className="sidebar-live" onClick={(event) => onRecognition(event.currentTarget.getBoundingClientRect())}>
            <span className={clsx("live-dot", liveStatus.paused && "paused")} />
            <span className="sidebar-live-copy">
              <strong>{liveStatus.paused ? "识别已暂停" : liveStatus.status === "running" ? "识别中 · 后台运行" : "识别已完成"}</strong>
              <em>
                {liveStatus.done}/{liveStatus.total}
                {liveStatus.rate ? ` · ${liveStatus.rate.toFixed(2)} 张/秒` : ""}
              </em>
            </span>
          </button>
        )}
        <button type="button" className="sidebar-action" onClick={(event) => onRecognition(event.currentTarget.getBoundingClientRect())}>
          <Sparkles size={13} strokeWidth={1.7} />
          <span>{liveStatus?.status === "running" ? "打开识别进度" : "识别进度"}</span>
        </button>
        <button type="button" className={clsx("sidebar-action", view === "settings" && "active")} onClick={onSettings}>
          <Settings size={13} strokeWidth={1.7} />
          <span>设置</span>
        </button>
        <div className="lib-line">
          <Database size={12} strokeWidth={1.7} />
          <span>{stats ? `${stats.assets} 张照片` : "正在读取…"}</span>
          <span className="lib-size">{stats?.db_size ? formatBytes(stats.db_size) : "本地库"}</span>
        </div>
        <div className="lib-sub" title={stats?.db_path || healthInfo?.data_dir || ""}>
          只读 SQLite · 本地优先
        </div>
      </div>
    </aside>
  );
}
