/** 与 styles.css 里的 --ease-* / --duration-* 保持一致，供 Web Animations API 使用。 */
export const EASE = {
  out: "cubic-bezier(0, 0, .58, 1)",
  outStrong: "cubic-bezier(.22, 1, .36, 1)",
  in: "cubic-bezier(.42, 0, 1, 1)",
  inOut: "cubic-bezier(.42, 0, .58, 1)",
  overshoot: "cubic-bezier(.34, 1.56, .64, 1)",
} as const;

export const DURATION = { sm: 180, md: 300, lg: 420 } as const;

export const reducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * 布局补位的弹簧观感：progress = 1 - exp(-7t) * cos(6t)，t 为 0..1。
 * t=0 → 0；先冲过头再回落，接近 1 时收敛。
 */
export function springGap(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return 1 - Math.exp(-7 * clamped) * Math.cos(6 * clamped);
}

/** 用 springGap 采样出一段 keyframes（只动 transform，不动尺寸）。 */
export function springKeyframes(from: string, steps = 18): Keyframe[] {
  const frames: Keyframe[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    // 把「位移比例」原样乘进 transform：from 里只会是 translate(dx, dy)
    frames.push({
      transform: scaleTranslate(from, springGap(t)),
      offset: t,
    });
  }
  frames.push({ transform: "none", offset: 1 });
  return frames;
}

function scaleTranslate(from: string, progress: number): string {
  const match = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(from);
  if (!match) return from;
  const dx = Number(match[1]) * (1 - progress);
  const dy = Number(match[2]) * (1 - progress);
  return `translate(${dx.toFixed(2)}px, ${dy.toFixed(2)}px)`;
}
