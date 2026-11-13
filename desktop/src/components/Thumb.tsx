import { useEffect, useState, type MouseEvent } from "react";
import { Check, ImageOff } from "lucide-react";
import clsx from "clsx";
import { assetSrc, type Asset } from "../api";
import { kindLabel } from "../utils";

type Props = {
  asset: Asset;
  dupCount?: number;
  selected?: boolean;
  multi?: boolean;
  onSelect: (asset: Asset, event: MouseEvent) => void;
  onOpen: (asset: Asset, rect?: DOMRect) => void;
};

export function Thumb({ asset, dupCount, selected, multi, onSelect, onOpen }: Props) {
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

  return (
    <button
      type="button"
      className={clsx("cell", selected && "selected")}
      data-asset-id={asset.id}
      aria-label={`${kindLabel(asset)} · ${asset.caption || asset.path}`}
      aria-pressed={selected}
      // 单击直接看大图；按住 ⌘/⌃/⇧ 才是多选（批量操作用）
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey) {
          onSelect(asset, event);
          return;
        }
        onOpen(asset, event.currentTarget.getBoundingClientRect());
      }}
      onDoubleClick={(event) => event.preventDefault()}
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
      <span className="badge glass-surface">{kindLabel(asset)}</span>
      {dupCount && dupCount > 1 && (
        <span className="dup-badge glass-surface" title={`同组 ${dupCount} 张，已折叠`}>
          ×{dupCount}
        </span>
      )}
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
