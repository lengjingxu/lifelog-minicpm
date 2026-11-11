import { useEffect, useState, type MouseEvent } from "react";
import { Check, ImageOff } from "lucide-react";
import clsx from "clsx";
import { assetSrc, type Asset } from "../api";
import { kindLabel } from "../utils";

type Props = {
  asset: Asset;
  selected?: boolean;
  multi?: boolean;
  onSelect: (asset: Asset, event: MouseEvent) => void;
  onOpen: (asset: Asset) => void;
};

export function Thumb({ asset, selected, multi, onSelect, onOpen }: Props) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setLoaded(false);
    setFailed(false);
  }, [asset.id, asset.thumb]);

  return (
    <button
      type="button"
      className={clsx("cell", selected && "selected")}
      data-asset-id={asset.id}
      aria-label={`${kindLabel(asset)} · ${asset.caption || asset.path}`}
      aria-pressed={selected}
      onClick={(event) => onSelect(asset, event)}
      onDoubleClick={() => onOpen(asset)}
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
            src={assetSrc(asset.thumb)}
            alt=""
            draggable={false}
            loading="lazy"
            decoding="async"
            className={clsx("thumb-img", loaded && "loaded")}
            onLoad={() => setLoaded(true)}
            onError={() => setFailed(true)}
          />
        )}
      </span>
      <span className="badge">{kindLabel(asset)}</span>
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
