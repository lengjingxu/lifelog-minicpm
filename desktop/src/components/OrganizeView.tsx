import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  AlertCircle,
  ArrowRight,
  Clock3,
  Gauge,
  LoaderCircle,
  Pause,
  Play,
  RotateCcw,
  Sparkles,
  X,
} from "lucide-react";
import clsx from "clsx";
import { assetSrc, type Asset } from "../api";
import { EASE, reducedMotion } from "../motion";
import type { LiveController } from "../live";

type Phase = "idle" | "running" | "done";
type CardStatus = "pile" | "queued" | "flying" | "placed";

type Position = { left: number; top: number; rotate: number; z: number };

type Card = {
  id: string;
  asset: Asset | null;
  status: CardStatus;
  group: string | null;
  groupSeq: number;
  /** 落位后的最终 transform（相对堆里原始位置的位移+缩放）。 */
  landedTransform?: string;
  failed: boolean;
  position: Position;
};

type Flight = {
  cardId: string;
  asset: Asset | null;
  group: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  width: number;
  height: number;
  rotate: number;
  launched: boolean;
};

type Group = { name: string; count: number; cards: Card[] };

type Props = {
  live: LiveController;
  assets: Asset[];
  demo?: { autostart?: boolean; speed?: number; count?: number };
  onViewAlbum: (tag: string) => void;
  onOpenRecognition: () => void;
  onToast: (message: string) => void;
};

const MAX_FLIGHTS = 3;
const MAX_SLOTS = 8;
const FLIGHT_MS = 620;

function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

function makePosition(id: string, index: number): Position {
  const a = hash(`${id}:x`);
  const b = hash(`${id}:y`);
  const c = hash(`${id}:r`);
  return {
    left: 12 + a * 68,
    top: 12 + b * 66,
    rotate: -8 + c * 16,
    z: 1 + (index % 40),
  };
}

function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "00:00";
  const whole = Math.ceil(seconds);
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
}

function remainingSeconds(total: number, done: number, rate: number | null): number | null {
  if (!rate || rate <= 0) return null;
  return Math.max(0, (total - done) / rate);
}

export function OrganizeView({ live, assets, onViewAlbum, onOpenRecognition, onToast }: Props) {
  const assetMap = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets]);
  const [cards, setCards] = useState<Card[]>([]);
  const [flights, setFlights] = useState<Flight[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const canvasRef = useRef<HTMLDivElement>(null);
  const timersRef = useRef<Set<number>>(new Set());
  const processedRef = useRef<Set<string>>(new Set());
  const eventIndexRef = useRef(0);
  const groupSeqRef = useRef(0);
  const cardsRef = useRef<Card[]>([]);
  const flightsRef = useRef<Flight[]>([]);
  const flyingRef = useRef(0);
  const groupOrderRef = useRef<Record<string, number>>({});
  const groupOrderSizeRef = useRef(0);
  const startingFlightsRef = useRef<Set<string>>(new Set());
  const pausedRef = useRef(false);
  const beginFlightRef = useRef<(card: Card) => void>(() => undefined);

  cardsRef.current = cards;
  flightsRef.current = flights;
  pausedRef.current = live.view.paused;

  const applyPhotos = useCallback((photos: LiveController["photos"], reset: boolean) => {
    setCards((previous) => {
      if (reset) {
        return photos.map((photo, index) => ({
          id: photo.id,
          asset: assetMap.get(photo.id) ?? null,
          status: "pile",
          group: null,
          groupSeq: Number.MAX_SAFE_INTEGER,
          failed: false,
          position: makePosition(photo.id, index),
        }));
      }
      const seen = new Set(previous.map((card) => card.id));
      const additions = photos
        .filter((photo) => !seen.has(photo.id))
        .map((photo, index) => ({
          id: photo.id,
          asset: assetMap.get(photo.id) ?? null,
          status: "pile" as const,
          group: null,
          groupSeq: Number.MAX_SAFE_INTEGER,
          failed: false,
          position: makePosition(photo.id, previous.length + index),
        }));
      return additions.length ? [...previous, ...additions] : previous;
    });
  }, [assetMap]);

  useEffect(() => {
    processedRef.current.clear();
    eventIndexRef.current = 0;
    groupSeqRef.current = 0;
    flyingRef.current = 0;
    flightsRef.current = [];
    groupOrderRef.current = {};
    groupOrderSizeRef.current = 0;
    startingFlightsRef.current.clear();
    for (const timer of timersRef.current) window.clearTimeout(timer);
    timersRef.current.clear();
    setFlights([]);
    setPhase(live.view.active ? "running" : "idle");
    setSelectedGroup(null);
    setCards(
      live.photos.map((photo, index) => ({
        id: photo.id,
        asset: assetMap.get(photo.id) ?? null,
        status: "pile",
        group: null,
        groupSeq: Number.MAX_SAFE_INTEGER,
        failed: false,
        position: makePosition(photo.id, index),
      })),
    );
    // resetToken intentionally owns the reset; assets are refreshed by the merge effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.resetToken]);

  useEffect(() => {
    if (!live.photos.length) return;
    applyPhotos(live.photos, false);
  }, [live.photos, applyPhotos]);

  useEffect(() => {
    if (live.view.active || !assets.length) return;
    setCards((previous) =>
      previous.length
        ? previous
        : assets.slice(0, 48).map((asset, index) => ({
            id: asset.id,
            asset,
            status: "pile" as const,
            group: null,
            groupSeq: Number.MAX_SAFE_INTEGER,
            failed: false,
            position: makePosition(asset.id, index),
          })),
    );
  }, [assets, live.view.active]);

  useEffect(() => {
    setCards((previous) =>
      previous.map((card) => {
        const asset = card.asset ?? assetMap.get(card.id) ?? null;
        return asset && asset !== card.asset ? { ...card, asset } : card;
      }),
    );
  }, [assetMap]);

  useEffect(() => {
    const all = live.events;
    if (eventIndexRef.current > all.length) eventIndexRef.current = 0;
    const batch = all.slice(eventIndexRef.current);
    if (!batch.length) return;
    eventIndexRef.current = all.length;

    setCards((previous) => {
      let next = previous;
      const ensureCard = (assetId: string): Card => {
        const index = next.findIndex((card) => card.id === assetId);
        if (index >= 0) return next[index];
        const card: Card = {
          id: assetId,
          asset: assetMap.get(assetId) ?? null,
          status: "pile",
          group: null,
          groupSeq: Number.MAX_SAFE_INTEGER,
          failed: false,
          position: makePosition(assetId, next.length),
        };
        next = [...next, card];
        return card;
      };

      for (const event of batch) {
        if (event.type !== "done" && event.type !== "error") continue;
        if (!event.asset_id) continue;
        if (processedRef.current.has(event.asset_id)) continue;
        processedRef.current.add(event.asset_id);
        const card = ensureCard(event.asset_id);
        const group = event.type === "error" ? "未归类" : event.tags?.[0]?.trim() || "未分类";
        groupSeqRef.current += 1;
        next = next.map((item) =>
          item.id === card.id
            ? {
                ...item,
                status: "queued",
                group,
                groupSeq: groupSeqRef.current,
                failed: event.type === "error",
              }
            : item,
        );
      }
      return next;
    });
  }, [live.events, assetMap]);

  const beginFlight = useCallback((card: Card) => {
    if (!card.group || startingFlightsRef.current.has(card.id)) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const canvasRect = canvas.getBoundingClientRect();
    // 关键：飞的就是堆里那张卡本身（同一节点），不另建克隆。
    const pileEl = canvas.querySelector<HTMLElement>(`[data-card-id="${card.id}"]`);
    if (!pileEl) return;
    const pileRect = pileEl.getBoundingClientRect();
    const width = pileRect.width || 104;
    const fromX = pileRect.left + pileRect.width / 2 - canvasRect.left;
    const fromY = pileRect.top + pileRect.height / 2 - canvasRect.top;
    const baseTransform = `translate(-50%, -50%) rotate(${card.position.rotate}deg)`;

    startingFlightsRef.current.add(card.id);
    setCards((previous) =>
      previous.map((item) => (item.id === card.id ? { ...item, status: "flying" } : item)),
    );

    // 落点：分组面板里那张卡的槽位
    const target = canvas.querySelector<HTMLElement>(`[data-target-card="${card.id}"]`);
    const targetRect = target?.getBoundingClientRect();
    const toX = targetRect ? targetRect.left + targetRect.width / 2 - canvasRect.left : fromX;
    const toY = targetRect ? targetRect.top + targetRect.height / 2 - canvasRect.top : fromY;
    const dx = toX - fromX;
    const dy = toY - fromY;
    const scale = targetRect && width ? targetRect.width / width : 0.82;
    const finalTransform = `translate(-50%, -50%) translate(${dx}px, ${dy}px) rotate(0deg) scale(${scale})`;
    flyingRef.current += 1;

    let settled = false;
    const release = () => {
      flightsRef.current = flightsRef.current.filter((item) => item.cardId !== card.id);
      setFlights(flightsRef.current);
      flyingRef.current = Math.max(0, flyingRef.current - 1);
    };

    const finish = () => {
      release();
      const timer = window.setTimeout(() => {
        timersRef.current.delete(timer);
        startingFlightsRef.current.delete(card.id);
        setCards((previous) =>
          previous.map((item) =>
            item.id === card.id ? { ...item, status: "placed", landedTransform: item.landedTransform } : item,
          ),
        );
      }, 40);
      timersRef.current.add(timer);
    };

    const onDone = () => {
      if (settled) return;
      settled = true;
      setCards((previous) =>
        previous.map((item) =>
          item.id === card.id ? { ...item, landedTransform: finalTransform } : item,
        ),
      );
      finish();
    };

    const reduced = reducedMotion();
    if (reduced) {
      // 减少动态效果：只淡出 → 不可见时换位 → 原地淡入，全程没有位移/缩放动画。
      const fadeOut = pileEl.animate(
        [{ opacity: 1 }, { opacity: 0 }],
        { duration: 140, easing: "linear", fill: "forwards" },
      );
      fadeOut.addEventListener(
        "finish",
        () => {
          pileEl.style.transform = finalTransform;
          const fadeIn = pileEl.animate(
            [{ opacity: 0 }, { opacity: 1 }],
            { duration: 160, easing: "linear", fill: "forwards" },
          );
          fadeIn.addEventListener("finish", () => onDone(), { once: true });
        },
        { once: true },
      );
      return;
    }

    flightsRef.current = [
      ...flightsRef.current,
      {
        cardId: card.id,
        asset: card.asset,
        group: card.group,
        fromX,
        fromY,
        toX,
        toY,
        width,
        height: pileRect.height,
        rotate: card.position.rotate,
        launched: true,
      },
    ];
    setFlights(flightsRef.current);

    const animation = pileEl.animate(
      [
        { transform: baseTransform, opacity: 1 },
        { transform: finalTransform, opacity: 1 },
      ],
      { duration: FLIGHT_MS, easing: EASE.out, fill: "forwards" },
    );
    animation.addEventListener("finish", onDone, { once: true });
    animation.addEventListener("cancel", onDone, { once: true });
  }, []);

  beginFlightRef.current = beginFlight;

  useEffect(() => {
    if (phase !== "running") return;
    const interval = window.setInterval(() => {
      if (pausedRef.current) return;
      const room = MAX_FLIGHTS - flyingRef.current;
      if (room <= 0) return;
      const queued = cardsRef.current
        .filter((card) => card.status === "queued" && !startingFlightsRef.current.has(card.id))
        .slice(0, room);
      for (const card of queued) beginFlightRef.current(card);
    }, 130);
    return () => window.clearInterval(interval);
  }, [phase]);

  useEffect(() => () => {
    for (const timer of timersRef.current) window.clearTimeout(timer);
  }, []);

  const groups = useMemo<Group[]>(() => {
    const map = new Map<string, Group>();
    for (const card of cards) {
      if (!card.group) continue;
      const group = map.get(card.group) ?? { name: card.group, count: 0, cards: [] };
      group.count += 1;
      group.cards.push(card);
      map.set(card.group, group);
    }
    // 面板位置在分组第一次出现时固定，之后只追加，绝不重排。
    const order = groupOrderRef.current;
    for (const name of map.keys()) {
      if (!(name in order)) order[name] = groupOrderSizeRef.current++;
    }
    // 槽位按「入组先后」排列：新卡只会追加到末尾，已有的落位槽不移动。
    for (const group of map.values()) {
      group.cards.sort((a, b) => a.groupSeq - b.groupSeq);
    }
    return [...map.values()].sort((a, b) => order[a.name] - order[b.name]);
  }, [cards]);

  const terminal = live.events.some(
    (event) => event.type === "session_done" || event.type === "session_stopped",
  );
  useEffect(() => {
    if (phase !== "running") return;
    if (live.view.status === "running") return;
    if (live.view.paused) return;
    if (!terminal || eventIndexRef.current < live.events.length) return;
    if (flights.length > 0) return;
    if (cards.some((card) => card.status === "queued" || card.status === "flying")) return;

    const piles = cards.filter((card) => card.status === "pile");
    if (piles.length) {
      setCards((previous) =>
        previous.map((card, index) =>
          card.status === "pile"
            ? {
                ...card,
                status: "placed",
                group: "未归类",
                groupSeq: groupSeqRef.current + index + 1,
                failed: true,
              }
            : card,
        ),
      );
      return;
    }

    const timer = window.setTimeout(() => setPhase("done"), 380);
    return () => window.clearTimeout(timer);
  }, [phase, live.view.status, live.view.paused, terminal, live.events.length, flights.length, cards]);

  const photoCount = cards.length || live.photos.length || assets.length;
  const estimateMinutes = Math.max(1, Math.ceil(photoCount / 1.2 / 60));
  const rate = live.view.rate;
  const safeTotal = Math.max(0, live.view.total);
  const safeDone = Math.min(safeTotal, Math.max(0, live.view.done));
  const remaining = remainingSeconds(safeTotal, safeDone, rate);
  const paused = live.view.paused;
  const rateLabel = rate === null ? "测速中" : rate <= 0 ? "计算中" : rate.toFixed(2);
  const currentTags = useMemo(() => {
    const starts = live.events.filter((event) => event.type === "start" && event.asset_id).slice(-3);
    return [
      ...new Set(
        starts
          .map((event) => assetMap.get(event.asset_id!)?.tags?.[0])
          .filter((tag): tag is string => Boolean(tag)),
      ),
    ];
  }, [live.events, assetMap]);

  const start = async () => {
    if (starting) return;
    setStarting(true);
    setPhase("running");
    const ok = await live.start({ mode: "sim", count: 18, concurrency: 4, speed: 2 });
    if (!ok) setPhase("idle");
    setStarting(false);
  };

  const undo = async () => {
    setPhase("idle");
    setSelectedGroup(null);
    await live.reset();
    onToast("已撤销本次整理，本次归位只存在于内存");
  };

  const viewAlbum = () => {
    const target = selectedGroup ?? groups[0]?.name;
    if (!target) return;
    if (target === "未归类") {
      onToast("未归类照片没有可筛选标签");
      return;
    }
    onViewAlbum(target);
  };

  return (
    <div className="organize-shell">
      {phase === "idle" && (
        <div className="organize-top organize-phase" key="idle">
          <button type="button" className="start-organize" onClick={() => void start()} disabled={starting}>
            {starting ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}
            开始整理
          </button>
          <div className="organize-quiet-meta">
            待整理 <strong>{photoCount}</strong> 张 · 预计 <strong>{estimateMinutes}</strong> 分钟
          </div>
        </div>
      )}

      {phase === "running" && (
        <div className="organize-hud organize-phase" key="running">
          <div className="hud-live">
            <span className={clsx("live-dot", paused && "paused")} />
            {paused ? "已暂停" : "整理中"}
          </div>
          <div className="hud-metric">
            <Gauge size={14} />
            <span>速度</span>
            <strong>{rateLabel}</strong>
            <em>张/秒</em>
          </div>
          <div className="hud-metric">
            <Sparkles size={14} />
            <span>已整理</span>
            <strong>{safeDone}</strong>
            <em>/ {safeTotal}</em>
          </div>
          <div className="hud-metric">
            <Clock3 size={14} />
            <span>剩余</span>
            <strong>{remaining === null ? (rate === 0 ? "计算中" : "—") : formatClock(remaining)}</strong>
          </div>
          <div className="hud-tags">
            {paused ? (
              <span className="hud-tags-note">
                会话已 stop · 继续会重开剩余 {Math.max(0, safeTotal - safeDone)} 张
              </span>
            ) : currentTags.length ? (
              [0, 1, 2].map((slot) => (
                <span className={clsx("hud-chip", !currentTags[slot] && "hud-chip-empty")} key={slot}>
                  {currentTags[slot] ?? ""}
                </span>
              ))
            ) : (
              <span className="hud-tags-note">读取画面…</span>
            )}
          </div>
          <button
            type="button"
            className="hud-pause"
            onClick={() => void (paused ? live.resume() : live.pause())}
            disabled={live.busy}
          >
            {paused ? <Play size={14} /> : <Pause size={14} />}
            {paused ? "继续" : "暂停"}
          </button>
        </div>
      )}

      {live.error && (
        <div className="organize-alert">
          <AlertCircle size={16} />
          <div>
            <strong>识别服务未启动，照片停在原堆</strong>
            <span>{live.error}</span>
          </div>
          <button type="button" className="ghost-button" onClick={onOpenRecognition}>
            查看识别进度
          </button>
        </div>
      )}

      {phase === "done" ? (
        <div className="organize-complete organize-phase" key="done">
          <header className="complete-head">
            <div>
              <div className="eyebrow">SORTED IN MEMORY</div>
              <h2>整理完成</h2>
              <p>
                {safeDone} 张已归位 · {groups.length} 个分组 · 失败 {live.view.failed} 张
              </p>
            </div>
            <button type="button" className="icon-button" onClick={() => void undo()} aria-label="撤销整理">
              <X size={16} />
            </button>
          </header>

          <div className="group-card-grid">
            {groups.map((group) => (
              <button
                type="button"
                key={group.name}
                className={clsx("group-card", "group-panel", "glass-surface", selectedGroup === group.name && "selected", group.name === "未归类" && "failed")}
                style={{ animationDelay: `${Math.min(groups.indexOf(group) * 35, 210)}ms` }}
                onClick={() => setSelectedGroup(group.name)}
              >
                <div className="group-card-title">
                  <span>{group.name}</span>
                  <strong>{group.count}</strong>
                </div>
                <div className="group-cover-grid">
                  {group.cards.slice(0, 6).map((card) => (
                    <div className="group-cover" key={card.id}>
                      {card.asset ? <img src={assetSrc(card.asset.thumb)} alt="" loading="lazy" /> : <div className="thumb-fallback" />}
                    </div>
                  ))}
                </div>
              </button>
            ))}
          </div>

          <footer className="complete-actions">
            <button type="button" className="primary-button" onClick={viewAlbum}>
              查看相册 <ArrowRight size={14} />
            </button>
            <button type="button" className="ghost-button" onClick={() => void undo()}>
              <RotateCcw size={14} /> 撤销整理
            </button>
            <span className="complete-note">仅在内存预演 · 未写入数据库</span>
          </footer>
        </div>
      ) : (
        <div className={clsx("organize-stage", phase === "idle" && "idle")} ref={canvasRef}>
          <div className={clsx("pile-area", phase === "running" && "running")}>
            {cards.map((card) =>
              card.status === "pile" ||
              card.status === "queued" ||
              card.status === "flying" ||
              card.status === "placed" ? (
                <div
                  key={card.id}
                  data-pile-card={card.id}
                  data-card-id={card.id}
                  className={clsx(
                    "pile-card",
                    card.status === "queued" && "queued",
                    card.status === "flying" && "flying",
                    card.status === "placed" && "placed",
                  )}
                  style={{
                    left: `${card.position.left}%`,
                    top: `${card.position.top}%`,
                    zIndex: card.status === "flying" ? 999 : card.position.z,
                    transform:
                      card.status === "placed" && card.landedTransform
                        ? card.landedTransform
                        : `translate(-50%, -50%) rotate(${card.position.rotate}deg)`,
                  }}
                >
                  {card.asset ? (
                    <img src={assetSrc(card.asset.thumb)} alt="" loading="lazy" draggable={false} />
                  ) : (
                    <div className="thumb-fallback">{card.id.slice(0, 2)}</div>
                  )}
                </div>
              ) : null,
            )}
            {phase === "idle" && cards.length === 0 && (
              <div className="pile-empty">
                <Sparkles size={22} />
                <span>正在读取待整理照片…</span>
              </div>
            )}
          </div>

          {phase === "running" && (
            <aside className="group-rail">
              <div className="group-rail-head">
                <span>归位区</span>
                <em>{groups.length}</em>
              </div>
              <div className="group-panels">
                {groups.map((group) => (
                  <section className={clsx("group-panel", group.name === "未归类" && "failed")} key={group.name}>
                    <span className="group-tab" aria-hidden="true" />
                    <span className="group-sheets" aria-hidden="true">
                      {group.cards.slice(0, 2).map((card, index) => (
                        <i
                          className="group-sheet"
                          key={card.id}
                          style={{ "--r": index === 0 ? "-7deg" : "7deg" } as CSSProperties}
                        >
                          {card.asset ? <img src={assetSrc(card.asset.thumb)} alt="" loading="lazy" /> : null}
                        </i>
                      ))}
                    </span>
                    <div className="group-front glass-surface on-color">
                    <header>
                      <span className="group-dot" />
                      <span>{group.name}</span>
                      <strong>{group.count}</strong>
                    </header>
                    {group.count > MAX_SLOTS && (
                      <span className="group-cap">显示最近 {MAX_SLOTS} 张</span>
                    )}
                    <div className="group-target-grid">
                      {group.cards.map((card, slot) => (
                        <div
                          className={clsx(
                            "group-target",
                            card.status === "flying" && "flight-target",
                            card.status === "queued" && "queued-target",
                            card.status === "placed" && "landed",
                          )}
                          key={card.id}
                          data-target-card={card.id}
                          style={{
                            gridRow: (Math.floor(slot / 4) % 2) + 1,
                            gridColumn: (slot % 4) + 1,
                          }}
                        >
                          {card.status === "placed" ? (
                            <span className="group-target-covered" aria-hidden="true" />
                          ) : null}
                        </div>
                      ))}
                    </div>
                    </div>
                  </section>
                ))}
                {groups.length === 0 && (
                  <div className="group-rail-empty">
                    <LoaderCircle size={16} className="spin" />
                    <span>等待第一张照片识别完成…</span>
                  </div>
                )}
              </div>
            </aside>
          )}

          <div className="flight-layer" aria-hidden="true">
            {flights.map((flight) => {
              const dx = flight.toX - flight.fromX;
              const dy = flight.toY - flight.fromY;
              const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
              const distance = Math.hypot(dx, dy);
              return (
                <div
                  key={`${flight.cardId}-trail`}
                  className="flight-trail"
                  style={{
                    transform: `translate(${flight.fromX}px, ${flight.fromY}px) translateY(-50%) rotate(${angle}deg) scaleX(${Math.max(0.36, distance / 100)})`,
                  }}
                />
              );
            })}
          </div>

          {phase === "running" && live.view.status === "running" && cards.length === 0 && (
            <div className="stage-loading">
              <LoaderCircle size={18} className="spin" /> 正在铺开照片…
            </div>
          )}
        </div>
      )}

      {phase !== "done" && (
        <button type="button" className="organize-recognition-link" onClick={onOpenRecognition}>
          <Sparkles size={13} /> 识别进度
        </button>
      )}
    </div>
  );
}
