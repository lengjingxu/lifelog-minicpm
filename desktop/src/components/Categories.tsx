import { useEffect, useState } from "react";
import clsx from "clsx";
import { Hash, Layers, MapPin, Tags, Users } from "lucide-react";
import { assetSrc, type GroupSummary } from "../api";
import type { CategoryKind } from "../utils";

type Props = {
  kind: CategoryKind;
  groups: GroupSummary[];
  loading: boolean;
  onPick: (kind: CategoryKind, name: string) => void;
  onKindChange: (kind: CategoryKind) => void;
};

const COPY: Record<CategoryKind, { title: string; note: string; icon: typeof Tags }> = {
  tags: { title: "AI 标签", note: "按模型给出的内容标签浏览，代表图取该标签下最新一张。", icon: Tags },
  people: { title: "人物", note: "相册里被识别到的人物与人数线索。", icon: Users },
  places: { title: "地点", note: "按 AI 识别的地点线索回看照片。", icon: MapPin },
  scenes: { title: "场景", note: "按模型识别的场景浏览，代表图取该场景下最新一张。", icon: Layers },
};

function Cover({ thumb }: { thumb: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [thumb]);
  if (!thumb || failed) return <span className="category-cover-fallback" aria-hidden="true" />;
  return (
    <img
      src={assetSrc(thumb)}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}

const TABS: { kind: CategoryKind; label: string }[] = [
  { kind: "tags", label: "标签" },
  { kind: "people", label: "人物" },
  { kind: "places", label: "地点" },
  { kind: "scenes", label: "场景" },
];

export function Categories({ kind, groups, loading, onPick, onKindChange }: Props) {
  const [activeKind, setActiveKind] = useState<CategoryKind>(kind);
  useEffect(() => setActiveKind(kind), [kind]);
  const copy = COPY[activeKind];
  const Icon = copy.icon;

  return (
    <div className="category-scroll">
      <div className="category-head">
        <div className="category-icon">
          <Icon size={18} strokeWidth={1.7} />
        </div>
        <div>
          <div className="category-eyebrow">分类浏览</div>
          <h2>{copy.title}</h2>
          <p>{copy.note}</p>
        </div>
        <div className="category-total">
          <span>{groups.length}</span>
          <small>个分类</small>
        </div>
      </div>

      <div className="category-tabs" role="tablist">
        {TABS.map((tab) => (
          <button
            key={tab.kind}
            type="button"
            role="tab"
            aria-selected={activeKind === tab.kind}
            className={clsx("category-tab", activeKind === tab.kind && "active")}
            onClick={() => { setActiveKind(tab.kind); onKindChange(tab.kind); }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="category-loading">正在整理分类…</div>
      ) : groups.length === 0 ? (
        <div className="category-loading">还没有可用的分类数据。</div>
      ) : (
        <div className="category-grid">
          {groups.map((group, index) => (
            <button
              type="button"
              className="category-card"
              key={group.name}
              onClick={() => onPick(activeKind, group.name)}
              style={{ animationDelay: Math.min(index, 10) * 24 + "ms" }}
            >
              <span className="category-cover">
                <Cover thumb={group.cover_thumb} />
              </span>
              <span className="category-front glass-surface on-color">
                <span className="category-meta">
                  <span className="category-name">
                    <Hash size={12} strokeWidth={1.8} />
                    {group.name}
                  </span>
                  <span className="category-count">{group.count} 张</span>
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
