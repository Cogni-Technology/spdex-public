/**
 * What makes a dialog modal, without a library: while it is open, Tab and
 * Shift+Tab stay inside it, the page behind doesn't scroll, and Escape
 * closes it; when it closes, focus goes back to whatever opened it.
 *
 * Without these a keyboard user tabbed out of the card dialog into the page
 * behind its backdrop, the wheel scrolled that page, and closing it left
 * focus on the body, a screen away from the button that opened it.
 */

import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE = 'a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';

export interface ModalOptions {
  /**
   * What takes focus when the dialog opens, instead of the dialog itself: the
   * disclaimer's text box, say, so the arrow keys and Space scroll it. Never a
   * control that asks the wallet or changes money or settings.
   */
  initialFocus?: RefObject<HTMLElement | null>;
}

export function useModal(dialog: RefObject<HTMLElement | null>, onClose: () => void, options: ModalOptions = {}): void {
  // Read through a ref: a parent that passes a new function on every render
  // must not restart this, which would move focus each time.
  const close = useRef(onClose);
  close.current = onClose;
  const initialFocus = options.initialFocus;

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    (initialFocus?.current ?? dialog.current)?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close.current();
        return;
      }
      const box = dialog.current;
      if (event.key !== "Tab" || box === null) return;
      const focusable = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => !el.hasAttribute("disabled") && el.getClientRects().length > 0,
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) {
        event.preventDefault();
        box.focus();
        return;
      }
      const active = document.activeElement;
      const inside = active instanceof Node && box.contains(active) && active !== box;
      if (event.shiftKey && (!inside || active === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (!inside || active === last)) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [dialog, initialFocus]);
}
