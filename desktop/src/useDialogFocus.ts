import { useEffect, useRef } from "react";
import { DURATION, EASE, reducedMotion } from "./motion";

export type GrowRect = { x: number; y: number; width: number; height: number };

// 对话框里可 Tab 到的元素。禁用的按钮不算，否则 trap 会把焦点丢到灰按钮上。
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

type Options = {
  /** 打开时把焦点放在容器上（读屏先播报对话框名），而不是第一个按钮。 */
  focusContainer?: boolean;
  /** 关闭时把焦点还给打开它的元素。嵌套对话框关掉内层时，外层仍在，不该抢焦点。 */
  restoreFocus?: boolean;
  /** 组件常驻但弹窗可能没开（如未挂载 DOM）时传 open，避免在隐藏状态下抢焦点。 */
  enabled?: boolean;
  /** 触发它的那个控件的矩形：弹窗从控件的框里长出来，而不是从中心缩放。 */
  growFrom?: GrowRect | null;
};

/**
 * 模态对话框的焦点管理：进入时移入焦点、Tab 循环限定在对话框内、Esc 关闭、关闭后焦点归还。
 * Esc 用捕获阶段并 stopPropagation，避免同时触发 App 里清空筛选/选中的全局 Escape。
 * 返回的 ref 挂到对话框的根元素上（需要能包含所有可聚焦子元素）。
 */
export function useDialogFocus<T extends HTMLElement>(onClose: () => void, options: Options = {}) {
  const { focusContainer = false, restoreFocus = true, enabled = true, growFrom = null } = options;
  const ref = useRef<T | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const node = ref.current;
    if (!node || !enabled) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const focusables = () =>
      Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (element) => element.offsetParent !== null || element === document.activeElement,
      );

    if (focusContainer) {
      node.focus({ preventScroll: true });
    } else {
      (focusables()[0] ?? node).focus({ preventScroll: true });
    }

    // 从控件本身长出来：尺寸、位置、圆角一起补间；里面的行在开度过半后 25ms 错峰落下。
    if (growFrom && !reducedMotion()) {
      const box = node.getBoundingClientRect();
      if (box.width && box.height) {
        const sx = Math.min(1, Math.max(0.35, growFrom.width / box.width));
        const sy = Math.min(1, Math.max(0.3, growFrom.height / box.height));
        const dx = growFrom.x + growFrom.width / 2 - (box.left + box.width / 2);
        const dy = growFrom.y + growFrom.height / 2 - (box.top + box.height / 2);
        const radius = getComputedStyle(node).borderRadius;
        node.animate(
          [
            { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, opacity: 0.75, borderRadius: "10px" },
            { transform: "none", opacity: 1, borderRadius: radius },
          ],
          { duration: DURATION.md, easing: EASE.outStrong },
        );
        node.querySelectorAll<HTMLElement>("[data-grow-stagger]").forEach((groupEl) => {
          Array.from(groupEl.children).forEach((child, index) => {
            (child as HTMLElement).animate(
              [{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }],
              { duration: 170, delay: 150 + index * 25, easing: EASE.out, fill: "backwards" },
            );
          });
        });
      }
    } else if (!reducedMotion()) {
      // 没有来处的弹窗（比如空状态里的导入）退化成轻微淡入，不硬切
      node.animate(
        [{ opacity: 0, transform: "scale(0.985)" }, { opacity: 1, transform: "none" }],
        { duration: 180, easing: EASE.out },
      );
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) {
        event.preventDefault();
        node.focus({ preventScroll: true });
        return;
      }
      const index = items.indexOf(document.activeElement as HTMLElement);
      const last = items.length - 1;
      if (event.shiftKey) {
        if (index <= 0) {
          event.preventDefault();
          items[last].focus();
        }
      } else if (index === last || index === -1) {
        event.preventDefault();
        items[0].focus();
      }
    };

    node.addEventListener("keydown", onKeyDown, true);
    return () => {
      node.removeEventListener("keydown", onKeyDown, true);
      if (restoreFocus && previous && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, [enabled, focusContainer, restoreFocus, growFrom]);

  return ref;
}