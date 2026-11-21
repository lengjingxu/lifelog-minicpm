import { Database, FolderOpen, FolderPlus, HardDrive } from "lucide-react";
import { pickFolder } from "../api";

type Props = {
  /** 上一次选择的失败原因：直接显示，不静默。 */
  error: string | null;
  busy: boolean;
  onOpen: (dir: string) => void;
  onCreate: (dir: string) => void;
  onDismiss?: () => void;
};

/** 首次启动/库失效时的引导页：选已有库，或在空文件夹里新建。 */
export function LibrarySetup({ error, busy, onOpen, onCreate, onDismiss }: Props) {
  const pick = async (kind: "open" | "create") => {
    const dir = await pickFolder({
      title: kind === "open" ? "选择已有库（包含 lifelog.sqlite）" : "选择空文件夹新建库",
    });
    if (!dir) return;
    if (kind === "open") onOpen(dir);
    else onCreate(dir);
  };

  return (
    <div className="library-setup">
      <div className="library-setup-card">
        <div className="library-setup-icon">
          <HardDrive size={22} strokeWidth={1.6} />
        </div>
        <h2>选择你的照片库</h2>
        <p>
          拾光在本机读取照片与 AI 描述。第一次使用需要指定数据目录；
          选好之后会记住，下次直接打开。
        </p>

        <div className="library-setup-actions">
          <button type="button" className="library-choice" disabled={busy} onClick={() => void pick("open")}>
            <FolderOpen size={18} strokeWidth={1.7} />
            <span>
              <b>选择已有库</b>
              <small>目录里要有 lifelog.sqlite</small>
            </span>
          </button>
          <button type="button" className="library-choice" disabled={busy} onClick={() => void pick("create")}>
            <FolderPlus size={18} strokeWidth={1.7} />
            <span>
              <b>新建库</b>
              <small>选一个空文件夹，自动建好结构</small>
            </span>
          </button>
        </div>

        {error && (
          <p className="library-setup-error" role="alert">
            <Database size={13} strokeWidth={1.8} /> {error}
          </p>
        )}

        {onDismiss && (
          <button type="button" className="ghost-button" onClick={onDismiss}>
            稍后再说
          </button>
        )}
      </div>
    </div>
  );
}
