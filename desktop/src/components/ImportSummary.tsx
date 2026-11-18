import { useMemo } from "react";
import { Copy, Images, Layers, Sparkles, Video } from "lucide-react";
import type { ImportSummary } from "../api";
import { formatBytes } from "../utils";

type Props = {
  /** 库汇总（只读聚合）。 */
  summary: ImportSummary;
  /** 这次 ingest 统计里新增的张数。 */
  added: number;
  /** 打开时是空库，首次导入走另一套副标题。 */
  firstImport: boolean;
  onBrowse: () => void;
  onCleanup: () => void;
  onRecognize: () => void;
};

function count(value: number | null | undefined): string {
  return (value ?? 0).toLocaleString();
}

function year(value: string | null): string | null {
  return value ? value.slice(0, 4) : null;
}

type Suggestion = {
  key: "unlabeled" | "dup" | "screenshots";
  text: string;
  action: string;
  run: () => void;
};

/** 导入刚结束时的总结页：这次进了多少、库里有什么、下一步最值得做什么。 */
export function ImportSummaryView({ summary, added, firstImport, onBrowse, onCleanup, onRecognize }: Props) {
  const span = useMemo(() => {
    const from = year(summary.first_day);
    const to = year(summary.last_day);
    if (!from) return "";
    if (!to || from === to) return from;
    return `${from}–${to}`;
  }, [summary.first_day, summary.last_day]);

  // 只留一条最相关的提示：没识别 > 重复 > 截屏。
  const suggestion = useMemo<Suggestion | null>(() => {
    if (summary.unlabeled > 0) {
      return {
        key: "unlabeled",
        text: `还有 ${count(summary.unlabeled)} 张没识别，人物/地点还是空的`,
        action: "开始识别",
        run: onRecognize,
      };
    }
    if (summary.dup.ready && summary.dup.count > 0) {
      return {
        key: "dup",
        text: `发现 ${count(summary.dup.groups)} 组重复，可回收 ${formatBytes(summary.dup.reclaim)}`,
        action: "去图库清理",
        run: onCleanup,
      };
    }
    if (summary.screenshots > 0) {
      return {
        key: "screenshots",
        text: `其中 ${count(summary.screenshots)} 张是屏幕截图`,
        action: "去图库清理",
        run: onCleanup,
      };
    }
    return null;
  }, [summary, onRecognize, onCleanup]);

  const subtitle = firstImport
    ? `这是你的第一批 ${count(summary.total)} 张`
    : `这次新增 ${count(added)} 张 · 共 ${formatBytes(summary.bytes)}`;

  return (
    <div className="import-summary">
      <div className="import-summary-body">
        <header className="import-summary-head">
          <h2>导入完成</h2>
          <p>{subtitle}</p>
        </header>

        <dl className="import-summary-stats">
          <div>
            <dt>
              <Images size={12} strokeWidth={1.8} /> 照片
            </dt>
            <dd>{count(summary.images)}</dd>
          </div>
          <div>
            <dt>
              <Video size={12} strokeWidth={1.8} /> 视频
            </dt>
            <dd>{count(summary.videos)}</dd>
          </div>
          <div>
            <dt>
              <Layers size={12} strokeWidth={1.8} /> 覆盖
            </dt>
            <dd>
              {count(summary.days)} <em>天</em>
            </dd>
            {span && <small>{span}</small>}
          </div>
        </dl>

        {suggestion && (
          <div className="import-summary-note" data-suggestion={suggestion.key}>
            <Sparkles size={13} strokeWidth={1.8} />
            <span>{suggestion.text}</span>
            <button type="button" className="ghost-button" onClick={suggestion.run}>
              {suggestion.action}
            </button>
          </div>
        )}

        <div className="import-summary-actions">
          <button type="button" className="primary-button" onClick={onBrowse}>
            开始浏览
          </button>
          <button type="button" className="ghost-button" onClick={onCleanup}>
            <Copy size={12} strokeWidth={1.9} /> 去图库清理
          </button>
        </div>
      </div>
    </div>
  );
}
