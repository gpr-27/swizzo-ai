'use client';

// Modal-dialog keyboard + focus behaviour for the shell's hand-rolled overlays
// (checkout confirm, restaurant-switch confirm, mobile tray drawer):
//  - moves focus into the dialog when it opens (first focusable, or the panel),
//  - traps Tab / Shift+Tab inside it,
//  - closes on Escape (unless `onClose` is omitted, e.g. while an order places),
//  - returns focus to whatever was focused before it opened.
// Pair with role="dialog" aria-modal="true" aria-labelledby on the panel.

import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useDialogA11y(
  open: boolean,
  panelRef: RefObject<HTMLElement | null>,
  onClose?: () => void,
) {
  // Latest onClose without re-running the effect (and re-stealing focus) on
  // every render.
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusables = () =>
      Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );

    // Initial focus: the first control, else the panel itself.
    const first = focusables()[0];
    if (first) first.focus();
    else {
      if (!panel.hasAttribute('tabindex')) panel.setAttribute('tabindex', '-1');
      panel.focus();
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (closeRef.current) {
          e.stopPropagation();
          closeRef.current();
        }
        return;
      }
      if (e.key !== 'Tab') return;
      const els = focusables();
      if (els.length === 0) {
        e.preventDefault();
        return;
      }
      const firstEl = els[0];
      const lastEl = els[els.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === firstEl || !panel.contains(active))) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && (active === lastEl || !panel.contains(active))) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      // Restore focus to the opener if it's still in the document.
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, [open, panelRef]);
}

export default useDialogA11y;
