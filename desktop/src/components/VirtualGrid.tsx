import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Asset } from "../api";
import { GAP } from "../utils";
import { Thumb } from "./Thumb";

type Props = {
  assets: Asset[];
  columns: number;
  selection: Set<string>;
  multi: boolean;
  onSelect: (asset: Asset, event: MouseEvent) => void;
  onOpen: (asset: Asset, rect?: DOMRect) => void;
  onLoadMore?: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
};

export function VirtualGrid({
  assets,
  columns,
  selection,
  multi,
  onSelect,
  onOpen,
  onLoadMore,
  hasMore = false,
  loadingMore = false,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const prevRects = useRef<Map<string, DOMRect>>(new Map());

  useEffect(() => {
    const element = innerRef.current;
    if (!element) return;
    const update = () => setWidth(element.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const rowHeight = width > 0 ? Math.max(120, (width - GAP * (columns - 1)) / columns) : 180;
  const rowCount = Math.ceil(assets.length / columns);
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight + GAP,
    overscan: 2,
  });

  useEffect(() => {
    virtualizer.measure();
  }, [rowHeight, columns, virtualizer]);

  const handleScroll = () => {
    const element = scrollRef.current;
    if (!element || !hasMore || !onLoadMore || loadingMore) return;
    if (element.scrollTop + element.clientHeight >= element.scrollHeight - rowHeight * 2) {
      onLoadMore();
    }
  };

  // 筛掉/重排时：同一张照片从旧位置滑到新位置，而不是瞬间重排。
  useLayoutEffect(() => {
    const container = innerRef.current;
    if (!container) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const next = new Map<string, DOMRect>();
    container.querySelectorAll<HTMLElement>("[data-asset-id]").forEach((el) => {
      next.set(el.dataset.assetId ?? "", el.getBoundingClientRect());
    });
    if (!reduced && prevRects.current.size) {
      next.forEach((rect, id) => {
        const prev = prevRects.current.get(id);
        if (!prev) return;
        const dx = prev.left - rect.left;
        const dy = prev.top - rect.top;
        if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
        const el = container.querySelector<HTMLElement>(`[data-asset-id="${id}"]`);
        el?.animate(
          [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }],
          { duration: 260, easing: "cubic-bezier(.32,.72,0,1)" },
        );
      });
    }
    prevRects.current = next;
  }, [assets, columns]);

  const virtualRows = virtualizer.getVirtualItems();

  return (
    <div
      ref={scrollRef}
      className="grid-scroll"
      data-grid-scroll
      onScroll={handleScroll}
      role="grid"
      aria-label="照片网格"
    >
      <div
        ref={innerRef}
        className="grid-inner"
        style={{ height: `${Math.max(virtualizer.getTotalSize(), rowHeight)}px` }}
      >
        {width > 0 &&
          virtualRows.map((virtualRow) => {
            const rowAssets = assets.slice(
              virtualRow.index * columns,
              virtualRow.index * columns + columns,
            );
            return (
              <div
                key={virtualRow.key}
                className="grid-row"
                style={{
                  height: `${rowHeight}px`,
                  transform: `translateY(${virtualRow.start}px)`,
                  gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                  gap: `${GAP}px`,
                }}
                role="row"
              >
                {rowAssets.map((asset) => (
                  <Thumb
                    key={asset.id}
                    asset={asset}
                    selected={selection.has(asset.id)}
                    multi={multi}
                    onSelect={onSelect}
                    onOpen={onOpen}
                  />
                ))}
              </div>
            );
          })}
        {loadingMore && <div className="load-more">正在加载更多…</div>}
      </div>
    </div>
  );
}
