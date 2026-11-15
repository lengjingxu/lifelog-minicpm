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
import { useDialogFocus } from "../useDialogFocus";
import { kindLabel, peopleList, splitList, timeLabel } from "../utils";

type Props = {
  asset: Asset;
  dup?: { count: number; keeperId: string };
  index: number;
  total: number;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  /** 已经加载到的列表里还有没有下一张；没传时按 total 推算。 */
  canNext?: boolean;
  onTag: (tag: string) => void;
  onAction: (label: string) => void;
  origin?: { x: number; y: number; w: number; h: number } | null;
  /** 上一张/下一张的方向：1 向右翻（内容从右侧进），-1 反之 */
  step?: number;
  closing?: boolean;
};

function MetaRow({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value?.trim() || "—"}</dd>
    </>
  );
}

export function Detail({ asset, dup, index, total, onClose, onPrev, onNext, onTag, onAction, origin, closing = false, canNext, step = 0 }: Props) {
  const [fullLoaded, setFullLoaded] = useState(false);
  const [fullFailed, setFullFailed] = useState(false);
  const fullRef = useRef<HTMLImageElement | null>(null);
  const dialogRef = useDialogFocus<HTMLDivElement>(onClose, { focusContainer: true });

  // 原图直接挂在可见的 img 上，但先不淡入：等 decode() 完成再显示。
  // 这样只有一次解码，且解码走异步路径，不会把 30-50ms 的活儿算进某一帧。
  useEffect(() => {
    setFullLoaded(false);
    setFullFailed(false);

    const el = fullRef.current;
    if (!el) return;
    let cancelled = false;

    const done = () => {
      if (!cancelled) setFullLoaded(true);
    };
    const fail = () => {
      if (!cancelled) setFullFailed(true);
    };

    if (typeof el.decode === 'function') {
      el.decode().then(done, fail);
    } else if (el.complete && el.naturalWidth > 0) {
      done();
    } else {
      el.addEventListener('load', done, { once: true });
      el.addEventListener('error', fail, { once: true });
    }

    return () => {
      cancelled = true;
    };
  }, [asset.id, asset.original]);

  const stageRef = useRef<HTMLDivElement | null>(null);

  // 详情里的图是 object-fit: contain，箱子等于整块舞台，真正显示的照片是居中的那一块。
  // 要让首尾帧和卡片对得上，缩放比必须按"照片那块"算，而不是按箱子算。
  const photoScale = (origin: { x: number; y: number; w: number; h: number }) => {
    const stage = stageRef.current;
    const img = fullRef.current;
    if (!stage) return null;
    // 打开/关闭时这个元素身上可能还有另一个补间，带着它量出来会失真
    stage.getAnimations().forEach((animation) => animation.cancel());
    const box = stage.getBoundingClientRect();
    if (!box.width || !box.height) return null;
    let pw = box.width;
    let ph = box.height;
    if (img?.naturalWidth && img.naturalHeight) {
      const aspect = img.naturalWidth / img.naturalHeight;
      if (box.width / box.height > aspect) {
        ph = box.height;
        pw = box.height * aspect;
      } else {
        pw = box.width;
        ph = box.width / aspect;
      }
    }
    return {
      dx: origin.x + origin.w / 2 - (box.left + box.width / 2),
      dy: origin.y + origin.h / 2 - (box.top + box.height / 2),
      sx: origin.w / pw,
      sy: origin.h / ph,
    };
  };

  // 从被点开的卡片长成详情大图
  useEffect(() => {
    const el = stageRef.current;
    if (!el || !origin) return;
    if (reducedMotion()) return;
    const t = photoScale(origin);
    if (!t) return;
    el.animate(
      [
        { transform: `translate(${t.dx}px, ${t.dy}px) scale(${t.sx}, ${t.sy})`, opacity: 0.6 },
        { transform: "none", opacity: 1 },
      ],
      { duration: DURATION.lg, easing: EASE.out },
    );
    // 只在打开时跑一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 关闭：沿打开时那条路径反向缩回原卡片（原卡片一直在底下，动画结束再卸载就是无缝的）。
  useEffect(() => {
    if (!closing) return;
    const el = stageRef.current;
    if (!el) return;
    if (reducedMotion()) return;
    const t = origin ? photoScale(origin) : null;
    if (!t) {
      el.animate([{ transform: "none", opacity: 1 }, { transform: "scale(0.94)", opacity: 0 }], {
        duration: DURATION.md,
        easing: EASE.inOut,
        fill: "forwards",
      });
      return;
    }
    el.animate(
      [
        { transform: "none", opacity: 1 },
        { transform: `translate(${t.dx}px, ${t.dy}px) scale(${t.sx}, ${t.sy})`, opacity: 0.9 },
      ],
      { duration: DURATION.md, easing: EASE.inOut, fill: "forwards" },
    );
    // origin 在打开时固定，关闭只看 closing
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closing]);

  // 翻页：内容按方向从侧边滑入，而不是同一张淡入
  useEffect(() => {
    const el = stageRef.current;
    if (!el || !step || reducedMotion()) return;
    el.animate(
      [
        { transform: `translateX(${step * 5}%)`, opacity: 0.35 },
        { transform: "none", opacity: 1 },
      ],
      { duration: 240, easing: EASE.outStrong },
    );
    // 只在 asset 变化时跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset.id]);

  const thumb = assetSrc(asset.thumb);
  const original = assetSrc(asset.original);
  const tags = asset.tags;
  const people = peopleList(asset.people).join("、");
  const place = splitList(asset.place).join("、");

  return (
    <div
      ref={dialogRef}
      className={clsx("overlay-root", closing && "closing")}
      role="dialog"
      aria-modal="true"
      aria-label="照片详情"
      tabIndex={-1}
    >
      <div className="stage" onClick={(event) => event.target === event.currentTarget && onClose()}>
        <div ref={stageRef} className={clsx("stage-image", fullLoaded && "full-ready")}>
          <img className="stage-thumb" src={thumb} alt="" aria-hidden="true" />
          {!fullFailed && (
            <img
              key={asset.id}
              className={clsx("stage-full", fullLoaded && "loaded")}
              ref={fullRef}
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
          disabled={canNext === undefined ? index >= total - 1 : !canNext}
          aria-label="下一张"
        >
          <ChevronRight size={18} strokeWidth={1.8} />
        </button>
        <div className="stage-counter">
          {index + 1} / {total}
        </div>
      </div>

      <aside className="inspector glass-surface">
        <button type="button" className="close-btn" onClick={onClose} aria-label="关闭详情">
          <X size={15} strokeWidth={1.9} />
        </button>

        <div className="inspector-kicker">{kindLabel(asset)} · 详情</div>
        <h2>{timeLabel(asset.taken_at)}</h2>
        <p className="file-name" title={asset.path}>{asset.path.split("/").pop()}</p>
        {dup && dup.count > 1 && (
          <p className="dup-note">
            {dup.keeperId === asset.id ? `同组 ${dup.count} 张 · 保留这张` : `同组 ${dup.count} 张 · 已折叠`}
          </p>
        )}

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
