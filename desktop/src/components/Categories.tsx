import { useEffect, useMemo, useState } from "react";
import { Hash, MapPin, Tags, Users } from "lucide-react";
import { assetSrc, type Asset } from "../api";
import { buildCategories, type CategoryKind } from "../utils";

type Props = {
  kind: CategoryKind;
  assets: Asset[];
  loading: boolean;
  onPick: (name: string) => void;
};

const COPY: Record<CategoryKind, { title: string; note: string; icon: typeof Tags }> = {
  tags: { title: "AI 标签", note: "按模型给出的内容标签浏览，代表图取该标签下最新一张。", icon: Tags },
  people: { title: "人物", note: "相册里被识别到的人物与人数线索。", icon: Users },
  places: { title: "地点", note: "按 AI 识别的地点线索回看照片。", icon: MapPin },
};

function Cover({ asset }: { asset: Asset }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [asset.id]);
  if (failed) return <span className="category-cover-fallback" aria-hidden="true" />;
  return (
    <img
      src={assetSrc(asset.thumb)}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}

export function Categories({ kind, assets, loading, onPick }: Props) {
  const groups = useMemo(() => buildCategories(assets, kind), [assets, kind]);
  const copy = COPY[kind];
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
              onClick={() => onPick(group.name)}
              style={{ animationDelay: `${Math.min(index, 10) * 24}ms` }}
            >
              <span className="category-cover">
                <Cover asset={group.cover} />
                <span className="category-scrim" />
              </span>
              <span className="category-meta">
                <span className="category-name">
                  <Hash size={12} strokeWidth={1.8} />
                  {group.name}
                </span>
                <span className="category-count">{group.count} 张</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
