import { useEffect, useRef, useState, type MouseEvent } from "react";
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
  onOpen: (asset: Asset) => void;
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
