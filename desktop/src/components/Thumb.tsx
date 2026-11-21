import { useEffect, useState, type MouseEvent } from "react";
import { Check, Heart, ImageOff } from "lucide-react";
import clsx from "clsx";
import { assetSrc, type Asset } from "../api";
import { kindLabel, timeLabel } from "../utils";

type Props = {
  asset: Asset;
  dupCount?: number;
  selected?: boolean;
  multi?: boolean;
  /** 选择模式：单击切换选中，不再打开详情 */
  selectMode?: boolean;
  /** 舒适密度显示描述；紧凑密度只留拍摄时间，避免网格太挤。 */
  density?: "comfort" | "compact";
  onSelect: (asset: Asset, event: MouseEvent) => void;
  onOpen: (asset: Asset, rect?: DOMRect) => void;
  /** 角落小心形：收藏/取消收藏。 */
  onToggleFavorite?: (asset: Asset) => void;
};

/** 紧凑密度用的短时间：2026-11-06，比「2026 年 11 月 6 日」省一半宽度。 */
function shortDay(asset: Asset): string {
  const raw = asset.taken_at || asset.day || "";
  return raw.slice(0, 10);
}

export function Thumb({
  asset,
  dupCount,
  selected,
  multi,
  selectMode = false,
  density = "comfort",
  onSelect,
  onOpen,
  onToggleFavorite,
}: Props) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [useOriginal, setUseOriginal] = useState(false);

  useEffect(() => {
    setLoaded(false);
    setFailed(false);
    setUseOriginal(false);
  }, [asset.id, asset.thumb]);

  // 缩略图缺失（大库很常见）时回落到原图，再失败才显示占位。
  const src = useOriginal ? asset.original : asset.thumb;
  const handleError = () => {
    if (!useOriginal && asset.original && asset.original !== asset.thumb) {
      setUseOriginal(true);
      return;
    }
    setFailed(true);
  };

  const compact = density === "compact";
  // 紧凑密度只留一行日期；舒适密度能放得下「时间 · 类型」。
  const metaText = compact
    ? shortDay(asset)
    : asset.caption?.trim() || `${timeLabel(asset.taken_at)} · ${kindLabel(asset)}`;

  return (
    <button
      type="button"
      className={clsx("cell", selected && "selected")}
      data-asset-id={asset.id}
      data-density={density}
      aria-label={`${kindLabel(asset)} · ${asset.caption || asset.path}`}
      aria-pressed={selected}
      // 普通模式单击看大图；选择模式下单击即选中，双击才看大图
      onClick={(event) => {
        if (selectMode || event.metaKey || event.ctrlKey || event.shiftKey) {
          onSelect(asset, event);
          return;
        }
        onOpen(asset, event.currentTarget.getBoundingClientRect());
      }}
      onDoubleClick={(event) => {
        event.preventDefault();
        if (selectMode) onOpen(asset, event.currentTarget.getBoundingClientRect());
      }}
    >
      <span className="thumb-frame">
        {!loaded && !failed && <span className="skeleton" aria-hidden="true" />}
        {failed ? (
          <span className="thumb-fallback">
            <ImageOff size={20} strokeWidth={1.6} />
            <span>无法读取</span>
          </span>
        ) : (
          <img
            src={assetSrc(src)}
            alt=""
            draggable={false}
            loading="lazy"
            decoding="async"
            className={clsx("thumb-img", loaded && "loaded")}
            onLoad={() => setLoaded(true)}
            onError={handleError}
          />
        )}
      </span>
      <span className="badge glass-surface on-color">{kindLabel(asset)}</span>
      {onToggleFavorite && (
        <button
          type="button"
          className={clsx("cell-favorite", asset.favorite && "on")}
          aria-label={asset.favorite ? "取消收藏" : "收藏"}
          aria-pressed={Boolean(asset.favorite)}
          title={asset.favorite ? "取消收藏" : "收藏"}
          onClick={(event) => {
            // 不要顺手打开详情：这个按钮只做收藏。
            event.preventDefault();
            event.stopPropagation();
            onToggleFavorite(asset);
          }}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <Heart size={12} strokeWidth={2} fill={asset.favorite ? "currentColor" : "none"} />
        </button>
      )}
      {dupCount && dupCount > 1 && (
        <span className="dup-badge glass-surface on-color" title={`同组 ${dupCount} 张，已折叠`}>
          ×{dupCount}
        </span>
      )}
      {/* 悬停时这张卡片靠 z-index 浮起来，信息按钮也拿回自己的层级，不会被它盖住 */}
      <span className="cell-meta" title={asset.caption || asset.path}>
        {metaText}
      </span>
      <span className="overlay">
        <span>{asset.caption || "尚未识别"}</span>
      </span>
      {selected && (
        <span className={clsx("select-mark", multi && "multi")} aria-hidden="true">
          <Check size={12} strokeWidth={2.4} />
        </span>
      )}
    </button>
  );
}
