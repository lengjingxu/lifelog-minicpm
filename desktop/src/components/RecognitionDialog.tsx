import clsx from "clsx";
import { useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Cloud,
  LoaderCircle,
  Pause,
  Play,
  Sparkles,
  X,
} from "lucide-react";
import type { Asset } from "../api";
import type { LiveController } from "../live";
import { assetSrc } from "../api";

type Props = {
  open: boolean;
  live: LiveController;
  assets: Map<string, Asset>;
  onClose: () => void;
  origin?: string;
  closing?: boolean;

};

function formatRemaining(total: number, done: number, rate: number | null): string {
  if (rate === null) return "等待测速";
  if (rate <= 0) return "计算中";
  if (done >= total || total <= 0) return "00:00";
  const seconds = Math.ceil((total - done) / rate);
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

export function RecognitionDialog({
  open,
  live,
  assets,
  onClose,
  origin = "50% 100%",
  closing = false,
}: Props) {
  const [count, setCount] = useState(18);
  const [concurrency, setConcurrency] = useState(4);
  const [speed, setSpeed] = useState(2);
  const [submitting, setSubmitting] = useState(false);

  const view = live.view;
  const total = Math.max(0, view.active ? view.total : count);
  const done = Math.min(total, Math.max(0, view.done));
  const failed = Math.min(Math.max(0, view.failed), Math.max(0, total - done));
  const pending = Math.max(0, total - done - failed);
  const progress = total > 0 ? Math.min(100, (done / total) * 100) : 0;
  const running = view.status === "running";
  const terminal = live.events.some(
    (event) => event.type === "session_done" || event.type === "session_stopped",
  );
  const finished = view.active && !running && !view.paused && (done + failed >= total || terminal);

  const inFlight = useMemo(() => {
    const latest = new Map<number, string>();
    for (const event of live.events) {
      if (event.type === "start" && event.asset_id) latest.set(event.slot ?? 0, event.asset_id);
      if ((event.type === "done" || event.type === "error") && event.asset_id) {
        for (const [slot, id] of latest) {
          if (id === event.asset_id) latest.delete(slot);
        }
      }
    }
    return [...latest.entries()]
      .sort((a, b) => a[0] - b[0])
      .slice(0, 3)
      .map(([slot, id]) => ({ slot, asset: assets.get(id) }));
  }, [live.events, assets]);

  if (!open) return null;

  const begin = async () => {
    setSubmitting(true);
    try {
      await live.start({ mode: "sim", count, concurrency, speed });
    } finally {
      setSubmitting(false);
    }
  };

  const primary = (() => {
    if (submitting || live.busy) {
      return (
        <button type="button" className="primary-button" disabled>
          <LoaderCircle size={14} className="spin" /> 正在准备
        </button>
      );
    }
    if (running) {
      return (
        <button type="button" className="primary-button" onClick={() => void live.pause()}>
          <Pause size={14} /> 暂停识别
        </button>
      );
    }
    if (view.active && view.paused) {
      return (
        <button type="button" className="primary-button" onClick={() => void live.resume()}>
          <Play size={14} /> 继续识别
        </button>
      );
    }
    return (
      <button type="button" className="primary-button" onClick={() => void begin()}>
        <Sparkles size={14} /> {view.active ? "再跑一轮" : "开始识别"}
      </button>
    );
  })();

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className={clsx("recognition-dialog dialog glass-surface", closing && "closing")}
        style={{ ["--dialog-origin" as string]: origin }}
        role="dialog"
        aria-modal="true"
        aria-label="识别进度"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog-head">
          <div>
            <div className="eyebrow">RECOGNITION</div>
            <h2>识别进度</h2>
            <p>小米云导入与 AI 打标在同一个现场，关闭后继续在后台运行。</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭识别进度">
            <X size={16} />
          </button>
        </header>

        {live.error && (
          <div className="inline-alert">
            <AlertCircle size={15} />
            <div>
              <strong>识别服务未启动</strong>
              <span>{live.error}</span>
            </div>
          </div>
        )}

        <div className="recognition-grid">
          <section className="recognition-block import-block">
            <div className="block-title">
              <Cloud size={16} />
              <span>小米云导入</span>
              <span className="status-pill muted">P2 占位</span>
            </div>
            <p className="block-copy">真实导入仍由 Python 侧完成，本阶段只展示入口与登录态。</p>
            <div className="import-row">
              <div>
                <strong>未连接</strong>
                <span>不执行真实下载，也不会写入数据库</span>
              </div>
              <button type="button" className="ghost-button" disabled>
                连接小米云
              </button>
            </div>
            <div className="import-placeholder">
              <div className="import-placeholder-head">
                <span>导入进度</span>
                <em>等待真实导入接入</em>
              </div>
              <div className="import-placeholder-track" />
              <div className="import-placeholder-foot">
                <span>云端相册</span>
                <span>本地扫描</span>
              </div>
            </div>
          </section>

          <section className="recognition-block mark-block">
            <div className="block-title">
              <Sparkles size={16} />
              <span>AI 识别打标</span>
              <span className="status-pill">{view.active ? (running ? "运行中" : view.paused ? "已暂停" : "已完成") : "待开始"}</span>
            </div>

            <div className="mark-controls">
              <label>
                <span>条数</span>
                <input
                  type="number"
                  min={1}
                  max={200}
                  value={count}
                  disabled={view.active}
                  onChange={(event) => setCount(Math.max(1, Number(event.target.value) || 1))}
                />
              </label>
              <label>
                <span>并发</span>
                <input
                  type="number"
                  min={1}
                  max={8}
                  value={concurrency}
                  disabled={view.active}
                  onChange={(event) => setConcurrency(Math.max(1, Math.min(8, Number(event.target.value) || 1)))}
                />
              </label>
              <label>
                <span>速度</span>
                <select
                  value={speed}
                  disabled={view.active}
                  onChange={(event) => setSpeed(Number(event.target.value))}
                >
                  <option value={1}>1× 实测</option>
                  <option value={2}>2×</option>
                  <option value={4}>4×</option>
                  <option value={8}>8×</option>
                </select>
              </label>
            </div>

            <div className="mark-progress">
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${progress}%` }} />
              </div>
              <div className="progress-meta">
                <span>{done} / {total} 张</span>
                <span>
                  {view.rate === null
                    ? "等待测速"
                    : view.rate <= 0
                      ? "速度计算中"
                      : `${view.rate.toFixed(2)} 张/秒`}
                </span>
                <span>剩余 {formatRemaining(total, done, view.rate)}</span>
              </div>
            </div>

            <div className="inflight-row">
              {[0, 1, 2].map((slot) => {
                const item = inFlight[slot];
                return (
                  <div className="inflight-card" key={slot}>
                    {item?.asset ? (
                      <img src={assetSrc(item.asset.thumb)} alt="正在识别" />
                    ) : (
                      <div className="inflight-empty">空闲</div>
                    )}
                    <span>槽位 {(item?.slot ?? slot) + 1}</span>
                  </div>
                );
              })}
              <div className="inflight-note">
                <span>正在处理</span>
                <strong>{inFlight.length}</strong>
                <span>路并发</span>
              </div>
            </div>

            <div className="dialog-actions">
              {primary}
              <button type="button" className="ghost-button" onClick={onClose}>
                后台运行
              </button>
            </div>
            <p className="dialog-footnote">
              暂停会调用 stop 结束当前会话；继续会按剩余条数重开会话，已完成进度按累计值保留。
            </p>
          </section>
        </div>

        <section className="recognition-stats">
          <div className="stat-box">
            <span>已打标</span>
            <strong>{done}</strong>
            <CheckCircle2 size={15} />
          </div>
          <div className="stat-box">
            <span>待处理</span>
            <strong>{pending}</strong>
            <LoaderCircle size={15} />
          </div>
          <div className="stat-box danger">
            <span>失败</span>
            <strong>{failed}</strong>
            <AlertCircle size={15} />
          </div>
          <div className="stat-note">
            {finished
              ? "本轮已完成。事件仍保留在内存里，可回到整理视图看归位结果。"
              : "数值来自 /api/live/state · 关闭弹窗不会中断任务"}
          </div>
        </section>
      </section>
    </div>
  );
}
