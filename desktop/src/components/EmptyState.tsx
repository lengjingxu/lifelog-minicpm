import { FolderSearch, Images, SearchX, Sparkles, X } from "lucide-react";

export type EmptyCondition = { key: string; label: string; remove: () => void };

type Props = {
  mode?: "library" | "search";
  onChoose: (label: string) => void;
  onReset?: () => void;
  /** 空结果时列出生效条件：每条都能单独去掉，不用「一把全清」。 */
  conditions?: EmptyCondition[];
};

export function EmptyState({ mode = "library", onChoose, onReset, conditions = [] }: Props) {
  if (mode === "search") {
    return (
      <div className="empty-state compact-empty empty-results">
        <div className="empty-icon">
          <SearchX size={24} strokeWidth={1.5} />
        </div>
        <h2>没有匹配的照片</h2>
        <p>试试去掉其中某个条件，或换个更短的关键词。</p>
        {conditions.length > 0 && (
          <div className="chip-row empty-conditions" aria-label="当前生效的条件">
            {conditions.map((condition) => (
              <span className="chip" key={condition.key} data-condition={condition.key}>
                {condition.label}
                <button
                  type="button"
                  onClick={condition.remove}
                  aria-label={`移除 ${condition.label}`}
                  title={`移除 ${condition.label}`}
                >
                  <X size={11} strokeWidth={2} />
                </button>
              </span>
            ))}
          </div>
        )}
        {onReset && (
          <button type="button" className="primary-btn" onClick={onReset}>
            {conditions.length > 1 ? "清除全部条件" : "放宽条件"}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="empty-state">
      <div className="empty-icon">
        <Images size={26} strokeWidth={1.5} />
      </div>
      <h2>相册还是空的</h2>
      <p>先把照片带进来。小米云、本地文件夹导入和逐张识别都已经接在真实链路上。</p>
      <div className="empty-actions">
        <button type="button" className="empty-card glass-panel" onClick={() => onChoose("导入小米相册")}>
          <Sparkles size={18} strokeWidth={1.6} />
          <span>
            <b>导入小米相册</b>
            <small>同步云端相册，保留拍摄时间与原始画质。</small>
          </span>
        </button>
        <button type="button" className="empty-card glass-panel" onClick={() => onChoose("扫描本地文件夹")}>
          <FolderSearch size={18} strokeWidth={1.6} />
          <span>
            <b>扫描本地文件夹</b>
            <small>选择一个目录，只建立索引，不移动原文件。</small>
          </span>
        </button>
      </div>
    </div>
  );
}
