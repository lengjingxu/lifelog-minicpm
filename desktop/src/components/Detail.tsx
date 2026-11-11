import { useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  FolderOpen,
  Plus,
  RotateCcw,
  X,
} from "lucide-react";
import clsx from "clsx";
import { assetSrc, type Asset } from "../api";
import { DURATION, EASE, reducedMotion } from "../motion";
import { kindLabel, peopleList, splitList, timeLabel } from "../utils";

type Props = {
  asset: Asset;
  index: number;
  total: number;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  onTag: (tag: string) => void;
  onAction: (label: string) => void;
  origin?: { x: number; y: number; w: number; h: number } | null;
};

function MetaRow({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value?.trim() || "—"}</dd>
    </>
  );
}

export function Detail({ asset, index, total, onClose, onPrev, onNext, onTag, onAction, origin }: Props) {
  const [fullLoaded, setFullLoaded] = useState(false);
  const [fullFailed, setFullFailed] = useState(false);

  useEffect(() => {
    setFullLoaded(false);
    setFullFailed(false);
  }, [asset.id]);

  const stageRef = useRef<HTMLDivElement | null>(null);

  // 从被点开的卡片长成详情大图（关闭时由外部直接移除）。
  useEffect(() => {
    const el = stageRef.current;
    if (!el || !origin) return;
    if (reducedMotion()) return;
    const target = el.getBoundingClientRect();
    if (!target.width || !target.height) return;
    const scaleX = origin.w / target.width;
    const scaleY = origin.h / target.height;
    const dx = origin.x + origin.w / 2 - (target.left + target.width / 2);
    const dy = origin.y + origin.h / 2 - (target.top + target.height / 2);
    el.animate(
      [
        { transform: `translate(${dx}px, ${dy}px) scale(${scaleX}, ${scaleY})`, opacity: 0.55 },
        { transform: "none", opacity: 1 },
      ],
      { duration: DURATION.lg, easing: EASE.out },
    );
    // 只在打开时跑一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const thumb = assetSrc(asset.thumb);
  const original = assetSrc(asset.original);
  const tags = asset.tags;
  const people = peopleList(asset.people).join("、");
  const place = splitList(asset.place).join("、");

  return (
    <div className="overlay-root" role="dialog" aria-modal="true" aria-label="照片详情">
      <div className="stage" onClick={(event) => event.target === event.currentTarget && onClose()}>
        <div ref={stageRef} className={clsx("stage-image", fullLoaded && "full-ready")}>
          <img className="stage-thumb" src={thumb} alt="" aria-hidden="true" />
          {!fullFailed && (
            <img
              key={asset.id}
              className={clsx("stage-full", fullLoaded && "loaded")}
              src={original}
              alt={asset.caption || asset.path}
              draggable={false}
              onLoad={() => setFullLoaded(true)}
              onError={() => setFullFailed(true)}
            />
          )}
          {!fullLoaded && !fullFailed && <span className="image-loading">载入原图…</span>}
        </div>

        <button
          type="button"
          className="nav-btn prev"
          onClick={onPrev}
          disabled={index <= 0}
          aria-label="上一张"
        >
          <ChevronLeft size={18} strokeWidth={1.8} />
        </button>
        <button
          type="button"
          className="nav-btn next"
          onClick={onNext}
          disabled={index >= total - 1}
          aria-label="下一张"
        >
          <ChevronRight size={18} strokeWidth={1.8} />
        </button>
        <div className="stage-counter">
          {index + 1} / {total}
        </div>
      </div>

      <aside className="inspector">
        <button type="button" className="close-btn" onClick={onClose} aria-label="关闭详情">
          <X size={15} strokeWidth={1.9} />
        </button>

        <div className="inspector-kicker">{kindLabel(asset)} · 详情</div>
        <h2>{timeLabel(asset.taken_at)}</h2>
        <p className="file-name" title={asset.path}>{asset.path.split("/").pop()}</p>

        <div className="section-label">AI 描述</div>
        <p className="caption">{asset.caption || "这张照片还没有 AI 描述。"}</p>

        <div className="section-label">识别信息</div>
        <dl className="meta-grid">
          <MetaRow label="时间" value={timeLabel(asset.taken_at)} />
          <MetaRow label="场景" value={asset.scene} />
          <MetaRow label="人物" value={people} />
          <MetaRow label="活动" value={asset.activity} />
          <MetaRow label="氛围" value={asset.mood} />
          <MetaRow label="地点" value={place} />
        </dl>

        <div className="section-label">标签</div>
        <div className="tag-cloud">
          {tags.length === 0 ? <span className="muted">暂无标签</span> : tags.map((tag) => (
            <button key={tag} type="button" onClick={() => onTag(tag)} title={`筛选 ${tag}`}>
              {tag}
            </button>
          ))}
        </div>

        <div className="section-label">图内文字</div>
        {asset.ocr_text?.trim() ? (
          <div className="ocr">{asset.ocr_text}</div>
        ) : (
          <div className="ocr empty-ocr">没有识别到文字</div>
        )}

        <div className="inspector-actions">
          <button type="button" onClick={() => onAction("重新识别")}>
            <RotateCcw size={13} strokeWidth={1.8} />重新识别
          </button>
          <button type="button" onClick={() => onAction("加入相册")}>
            <Plus size={13} strokeWidth={1.8} />加入相册
          </button>
          <button type="button" onClick={() => onAction("导出")}>
            <Download size={13} strokeWidth={1.8} />导出
          </button>
          <button type="button" onClick={() => onAction("在 Finder 中显示")}>
            <FolderOpen size={13} strokeWidth={1.8} />Finder 中显示
          </button>
        </div>
      </aside>
    </div>
  );
}
