import { FolderSearch, Images, SearchX, Sparkles } from "lucide-react";

type Props = {
  mode?: "library" | "search";
  onChoose: (label: string) => void;
  onReset?: () => void;
};

export function EmptyState({ mode = "library", onChoose, onReset }: Props) {
  if (mode === "search") {
    return (
      <div className="empty-state compact-empty">
        <div className="empty-icon">
          <SearchX size={24} strokeWidth={1.5} />
        </div>
        <h2>没有匹配的照片</h2>
        <p>试试更短的关键词，或移除一个标签、人物、地点条件。</p>
        {onReset && (
          <button type="button" className="primary-btn" onClick={onReset}>
            放宽条件
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
      <p>先把照片带进来。拾光只读本地库，导入与识别会在 P2 接通。</p>
      <div className="empty-actions">
        <button type="button" className="empty-card" onClick={() => onChoose("导入小米相册")}>
          <Sparkles size={18} strokeWidth={1.6} />
          <span>
            <b>导入小米相册</b>
            <small>同步云端相册，保留拍摄时间与原始画质。</small>
          </span>
        </button>
        <button type="button" className="empty-card" onClick={() => onChoose("扫描本地文件夹")}>
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
