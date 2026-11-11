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
