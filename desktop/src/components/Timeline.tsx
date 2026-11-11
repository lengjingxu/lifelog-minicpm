import { useMemo, type CSSProperties, type MouseEvent } from "react";
import type { Asset } from "../api";
import { monthLabel } from "../utils";
import { Thumb } from "./Thumb";

type Props = {
  assets: Asset[];
  compact: boolean;
  selection: Set<string>;
  multi: boolean;
  onSelect: (asset: Asset, event: MouseEvent) => void;
  onOpen: (asset: Asset) => void;
};

export function Timeline({ assets, compact, selection, multi, onSelect, onOpen }: Props) {
  const groups = useMemo(() => {
    const map = new Map<string, Asset[]>();
    for (const asset of assets) {
      const month = asset.day?.slice(0, 7) || "unknown";
      const list = map.get(month);
      if (list) list.push(asset);
      else map.set(month, [asset]);
    }
    return [...map.entries()].sort(([a], [b]) => b.localeCompare(a));
  }, [assets]);

  const style = { "--cell-min": compact ? "132px" : "160px" } as CSSProperties;

  return (
    <div className="timeline-scroll" data-timeline-scroll>
      {groups.map(([month, list], groupIndex) => (
        <section className="month-group" key={month}>
          <div className="month-header">
            <span className="month-title">{month === "unknown" ? "时间未知" : monthLabel(month)}</span>
            <span className="month-count">· {list.length} 张</span>
            {groupIndex === 0 && <span className="month-hint">最近</span>}
          </div>
          <div className="timeline-grid" style={style}>
            {list.map((asset) => (
              <div className="timeline-cell" key={asset.id}>
                <Thumb
                  asset={asset}
                  selected={selection.has(asset.id)}
                  multi={multi}
                  onSelect={onSelect}
                  onOpen={onOpen}
                />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
