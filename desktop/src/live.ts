import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  liveEvents,
  liveHealth,
  livePhotos,
  liveStart,
  liveState,
  liveStop,
  type LiveEvent,
  type LiveHealth,
  type LivePhoto,
  type LiveState,
  type LiveStatus,
} from "./api";

export type StartOptions = {
  mode?: string;
  count?: number;
  concurrency?: number;
  speed?: number;
};

export type LiveView = {
  raw: LiveState | null;
  status: LiveStatus;
  mode: string | null;
  total: number;
  done: number;
  rate: number | null;
  elapsed_ms: number;
  concurrency: number;
  extra: Record<string, unknown>;
  failed: number;
  paused: boolean;
  active: boolean;
};

export type LiveController = {
  view: LiveView;
  photos: LivePhoto[];
  events: LiveEvent[];
  health: LiveHealth | null;
  error: string | null;
  busy: boolean;
  resetToken: number;
  activate: () => Promise<void>;
  start: (options?: StartOptions) => Promise<boolean>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  reset: () => Promise<void>;
  clearError: () => void;
};

type Offsets = { done: number; total: number };

export function useLiveController(): LiveController {
  const [raw, setRaw] = useState<LiveState | null>(null);
  const [photos, setPhotos] = useState<LivePhoto[]>([]);
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [offsets, setOffsets] = useState<Offsets>({ done: 0, total: 0 });
  const [paused, setPaused] = useState(false);
  const [activated, setActivated] = useState(false);
  const [health, setHealth] = useState<LiveHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resetToken, setResetToken] = useState(0);

  const cursorRef = useRef(0);
  const eventsRef = useRef<LiveEvent[]>([]);
  const lastOptions = useRef<StartOptions>({ mode: "sim", count: 24, concurrency: 4, speed: 2 });
  const pollingRef = useRef(false);
  const rawRef = useRef<LiveState | null>(null);
  const offsetsRef = useRef<Offsets>({ done: 0, total: 0 });

  const recordState = useCallback((next: LiveState) => {
    rawRef.current = next;
    setRaw(next);
  }, []);

  const recordOffsets = useCallback((next: Offsets) => {
    offsetsRef.current = next;
    setOffsets(next);
  }, []);

  const appendEvents = useCallback((batch: LiveEvent[]) => {
    if (!batch.length) return;
    eventsRef.current = [...eventsRef.current, ...batch];
    setEvents(eventsRef.current);
  }, []);

  const drain = useCallback(async () => {
    const result = await liveEvents(cursorRef.current);
    cursorRef.current = result.cursor;
    appendEvents(result.events);
  }, [appendEvents]);

  const waitStopped = useCallback(async () => {
    const deadline = Date.now() + 2400;
    let next = await liveState();
    recordState(next);
    while (next.status === "running" && Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 120));
      next = await liveState();
      recordState(next);
    }
    return next;
  }, [recordState]);

  const activate = useCallback(async () => {
    setActivated(true);
    try {
      const nextHealth = await liveHealth();
      setHealth(nextHealth);
      if (nextHealth.state) recordState(nextHealth.state);
      if (nextHealth.state && nextHealth.state.status !== "idle") {
        const queue = await livePhotos();
        if (queue.length) {
          setPhotos((previous) => dedupePhotos([...previous, ...queue]));
        }
      }
      setError(null);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      setHealth({ ok: false, error: message });
    }
  }, [recordState]);

  useEffect(() => {
    if (!activated) return;
    let cancelled = false;
    let timer: number | null = null;

    const tick = async () => {
      if (cancelled || pollingRef.current) return;
      pollingRef.current = true;
      try {
        const next = await liveState();
        if (!cancelled) recordState(next);
        const result = await liveEvents(cursorRef.current);
        if (!cancelled) {
          cursorRef.current = result.cursor;
          appendEvents(result.events);
        }
      } catch (reason) {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      } finally {
        pollingRef.current = false;
        if (!cancelled) {
          const running = rawRef.current?.status === "running";
          timer = window.setTimeout(tick, running ? 320 : 900);
        }
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [activated, appendEvents, recordState]);

  const start = useCallback(
    async (options: StartOptions = {}) => {
      setBusy(true);
      setError(null);
      const merged = { mode: "sim", count: 24, concurrency: 4, speed: 2, ...options };
      lastOptions.current = merged;
      try {
        if (rawRef.current?.status === "running") {
          await liveStop();
          await waitStopped();
        }
        const result = await liveStart(merged);
        if (!result.ok) {
          setError(result.error ?? "识别服务没有返回会话");
          return false;
        }
        recordOffsets({ done: 0, total: 0 });
        cursorRef.current = 0;
        eventsRef.current = [];
        setEvents([]);
        setPhotos(dedupePhotos(result.photos ?? []));
        if (result.state) recordState(result.state);
        setPaused(false);
        setResetToken((value) => value + 1);
        setActivated(true);
        if (!result.photos?.length) {
          const queue = await livePhotos();
          if (queue.length) setPhotos(dedupePhotos(queue));
        }
        return true;
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [recordOffsets, recordState, waitStopped],
  );

  const pause = useCallback(async () => {
    if (rawRef.current?.status !== "running") return;
    setBusy(true);
    try {
      await drain();
      const result = await liveStop();
      if (!result.ok && result.error && result.error !== "没有进行中的会话") {
        setError(result.error);
      }
      setPaused(true);
      await waitStopped();
      await drain();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }, [drain, waitStopped]);

  const resume = useCallback(async () => {
    const current = rawRef.current;
    if (!current || current.status === "running") {
      setPaused(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await drain();
      const currentOffsets = offsetsRef.current;
      const done = currentOffsets.done + current.done;
      const total = currentOffsets.total + current.total;
      const remaining = Math.max(1, total - done);
      cursorRef.current = 0;
      const result = await liveStart({ ...lastOptions.current, count: remaining });
      if (!result.ok) {
        setError(result.error ?? "无法继续识别");
        return;
      }
      const nextTotal = Math.max(0, result.state?.total ?? remaining);
      recordOffsets({ done, total: Math.max(done, total - nextTotal) });
      if (result.state) recordState(result.state);
      if (result.photos?.length) {
        setPhotos((previous) => dedupePhotos([...previous, ...(result.photos ?? [])]));
      }
      setPaused(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }, [drain, recordOffsets, recordState]);

  const reset = useCallback(async () => {
    setBusy(true);
    try {
      if (rawRef.current?.status === "running") await liveStop();
    } catch {
      // The local reset still wins if the sidecar went away.
    } finally {
      setRaw(null);
      rawRef.current = null;
      setPhotos([]);
      setEvents([]);
      eventsRef.current = [];
      cursorRef.current = 0;
      recordOffsets({ done: 0, total: 0 });
      setPaused(false);
      setError(null);
      setResetToken((value) => value + 1);
      setBusy(false);
    }
  }, [recordOffsets]);

  const failed = useMemo(() => events.filter((event) => event.type === "error").length, [events]);

  const view = useMemo<LiveView>(() => {
    const status = raw?.status ?? "idle";
    return {
      raw,
      status,
      mode: raw?.mode ?? null,
      total: offsets.total + (raw?.total ?? 0),
      done: offsets.done + (raw?.done ?? 0),
      rate: raw?.rate ?? null,
      elapsed_ms: raw?.elapsed_ms ?? 0,
      concurrency: raw?.concurrency ?? 0,
      extra: raw?.extra ?? {},
      failed,
      paused,
      active: status !== "idle",
    };
  }, [raw, offsets, failed, paused]);

  return {
    view,
    photos,
    events,
    health,
    error,
    busy,
    resetToken,
    activate,
    start,
    pause,
    resume,
    reset,
    clearError: () => setError(null),
  };
}

function dedupePhotos(photos: LivePhoto[]): LivePhoto[] {
  const seen = new Set<string>();
  const output: LivePhoto[] = [];
  for (const photo of photos) {
    if (seen.has(photo.id)) continue;
    seen.add(photo.id);
    output.push(photo);
  }
  return output;
}
