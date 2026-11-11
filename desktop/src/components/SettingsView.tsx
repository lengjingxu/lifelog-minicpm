import { useEffect, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Database,
  FolderOpen,
  HardDrive,
  Keyboard,
  LoaderCircle,
  RefreshCw,
  UserRound,
} from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { appSettings, generateThumbs, rebuildThumbs, thumbStatus, type AppSettings, type ThumbStatus } from "../api";
import { formatBytes } from "../utils";

const SHORTCUTS: [string, string][] = [
  ["⌘ K", "聚焦搜索"],
  ["⌘ 1 / ⌘ 2", "网格 / 时间线"],
  ["⌘ 3", "跳到搜索"],
  ["⌘ + / ⌘ -", "舒适 / 紧凑网格"],
  ["↑ ↓ ← →", "网格内移动"],
  ["回车 / 空格", "打开详情 / 预览"],
  ["Esc", "关闭详情或搜索"],
  ["⌘ A", "全选当前视图"],
];

export function SettingsView({ onToast }: { onToast: (message: string) => void }) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildOutput, setRebuildOutput] = useState<string | null>(null);
  const [gap, setGap] = useState<ThumbStatus | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number; rate: number; eta: number | null } | null>(null);
  const [generating, setGenerating] = useState(false);

  const load = () => {
    setLoading(true);
    setError(null);
    appSettings()
      .then(setSettings)
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  useEffect(() => {
    void thumbStatus().then(setGap).catch(() => setGap(null));
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<{ done: number; total: number; rate_per_s?: number; eta_s?: number | null }>(
      "thumbs-progress",
      (event) => {
        const payload = event.payload;
        setProgress({
          done: payload.done ?? 0,
          total: payload.total ?? 0,
          rate: payload.rate_per_s ?? 0,
          eta: payload.eta_s ?? null,
        });
      },
    ).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  const runGenerate = async () => {
    setGenerating(true);
    setProgress({ done: 0, total: gap?.missing ?? 0, rate: 0, eta: null });
    try {
      await generateThumbs(false);
      const next = await thumbStatus();
      setGap(next);
      onToast(next.missing === 0 ? "缩略图已补齐" : `仍缺 ${next.missing} 张，失败项已记入 broken.json`);
    } catch (err) {
      onToast(`生成失败：${String(err)}`);
    } finally {
      setGenerating(false);
      setProgress(null);
    }
  };

  const rebuild = async () => {
    setRebuilding(true);
    setRebuildOutput(null);
    try {
      const result = await rebuildThumbs();
      setRebuildOutput([result.stdout, result.stderr].filter(Boolean).join("\n").trim() || "完成");
      onToast(result.ok ? "缩略图缓存已重建" : "缩略图重建有失败项，请查看输出");
      load();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setRebuildOutput(message);
      onToast(message);
    } finally {
      setRebuilding(false);
    }
  };

  if (loading && !settings) {
    return (
      <div className="settings-scroll">
        <div className="loading-state">
          <LoaderCircle size={20} className="spin" />
          <span>正在读取本机设置…</span>
        </div>
      </div>
    );
  }

  if (error || !settings) {
    return (
      <div className="settings-scroll">
        <div className="error-state">
          <AlertCircle size={22} />
          <h2>读取设置失败</h2>
          <p>{error ?? "没有返回设置"}</p>
          <button type="button" className="ghost-button" onClick={load}>重试</button>
        </div>
      </div>
    );
  }

  return (
    <div className="settings-scroll">
      <div className="settings-intro">
        <div className="eyebrow">LOCAL FIRST</div>
        <h2>只读、本地、可修复</h2>
        <p>设置页展示桌面端实际使用的库、模型与缓存。数据源与写入动作仍由 Python 侧掌控。</p>
      </div>

      <div className="settings-grid">
        <section className="settings-card wide">
          <div className="settings-card-head">
            <Database size={16} />
            <h3>资料库</h3>
            <span className="status-pill muted">只读</span>
          </div>
          <dl className="settings-list">
            <div>
              <dt>库路径</dt>
              <dd title={settings.data_dir}>{settings.data_dir}</dd>
            </div>
            <div>
              <dt>数据库</dt>
              <dd title={settings.db_path}>{settings.db_path}</dd>
            </div>
            <div>
              <dt>数据库大小</dt>
              <dd>{formatBytes(settings.db_size)}</dd>
            </div>
            <div>
              <dt>资料库占用</dt>
              <dd>{formatBytes(settings.data_size)} · {settings.data_files} 个文件</dd>
            </div>
          </dl>
        </section>

        <section className="settings-card">
          <div className="settings-card-head">
            <HardDrive size={16} />
            <h3>当前模型</h3>
            <span className={settings.model.available ? "status-pill" : "status-pill muted"}>
              {settings.model.available ? "已就位" : "未找到"}
            </span>
          </div>
          <div className="model-name">{settings.model.title}</div>
          <div className="model-key">{settings.model.key}</div>
          <p className="settings-copy">{settings.model.role}</p>
          <div className="path-note" title={settings.model.path}>{settings.model.path}</div>
          <p className="settings-hint">模型选择由后端配置决定，本页只读展示。</p>
        </section>

        <section className="settings-card">
          <div className="settings-card-head">
            <FolderOpen size={16} />
            <h3>缩略图缓存</h3>
          </div>
          <div className="cache-number">{formatBytes(settings.thumb_cache.size)}</div>
          <div className="model-key">
            {settings.thumb_cache.count} 张缩略图
            {gap ? ` · 库内 ${gap.assets} 张${gap.missing > 0 ? `，缺 ${gap.missing} 张` : "，已齐全"}` : ""}
          </div>
          {progress && (
            <div className="model-key">
              已处理 {progress.done} / {progress.total}
              {progress.rate > 0 ? ` · ${progress.rate.toFixed(1)} 张/秒` : ""}
              {progress.eta !== null ? ` · 剩余 ${progress.eta}s` : ""}
            </div>
          )}
          <div className="path-note" title={settings.thumb_cache.path}>{settings.thumb_cache.path}</div>
          <button type="button" className="ghost-button full" onClick={() => void rebuild()} disabled={rebuilding}>
            {rebuilding ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}
            {rebuilding ? "正在重建…" : "重建缩略图缓存"}
          </button>
          <button
            type="button"
            className="ghost-button full"
            onClick={() => void runGenerate()}
            disabled={generating || rebuilding}
          >
            {generating ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}
            {generating ? "正在补齐…" : "补齐缺失缩略图"}
          </button>
          {rebuildOutput && <pre className="rebuild-output">{rebuildOutput}</pre>}
        </section>

        <section className="settings-card">
          <div className="settings-card-head">
            <UserRound size={16} />
            <h3>小米账号</h3>
            <span className={settings.xiaomi.logged_in ? "status-pill" : "status-pill muted"}>
              {settings.xiaomi.logged_in ? "已登录" : "未登录"}
            </span>
          </div>
          <div className="login-line">
            {settings.xiaomi.logged_in ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
            <div>
              <strong>{settings.xiaomi.logged_in ? "登录态文件存在" : "未检测到登录态"}</strong>
              <span>{settings.xiaomi.detail}</span>
            </div>
          </div>
          <div className="path-note">{settings.xiaomi.token_dir}</div>
          <p className="settings-hint">仅显示状态；P2 不执行真实小米云导入。</p>
        </section>

        <section className="settings-card wide shortcuts-card">
          <div className="settings-card-head">
            <Keyboard size={16} />
            <h3>快捷键</h3>
          </div>
          <div className="shortcut-grid">
            {SHORTCUTS.map(([keys, label]) => (
              <div className="shortcut-row" key={keys}>
                <kbd>{keys}</kbd>
                <span>{label}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
