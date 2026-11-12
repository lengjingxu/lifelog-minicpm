import { useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { assetSrc, type MonthSummary } from "../api";
import { monthLabel } from "../utils";

type Props = {
  months: MonthSummary[];
  onOpenMonth: (month: string) => void;
};

/**
 * 时间线只渲染月份摘要（10 万条也就一百多行），点月份再回图库按月分页。
 * 之前是把全库塞进内存再 groups.map -> list.map 全量渲染，10 万条会生成 10 万个格子。
 */
export function Timeline({ months, onOpenMonth }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: months.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 104,
    overscan: 3,
  });

  return (
    <div className="timeline-scroll" data-timeline-scroll ref={scrollRef}>
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((item) => {
          const month = months[item.index];
          return (
            <button
              type="button"
              key={month.month}
              className="month-row"
              onClick={() => onOpenMonth(month.month)}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                height: item.size,
                transform: "translateY(" + item.start + "px)",
              }}
            >
              <span className="month-cover">
                {month.cover_thumb ? (
                  <img src={assetSrc(month.cover_thumb)} alt="" loading="lazy" decoding="async" draggable={false} />
                ) : null}
              </span>
              <span className="month-meta">
                <span className="month-title">{month.month === "unknown" ? "时间未知" : monthLabel(month.month)}</span>
                <span className="month-count">· {month.count} 张</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
