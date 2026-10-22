'use client';

// A small "Share" chip for the dark cart tray. Tapping it asks the parent to
// build + copy a shareable link to the current basket, then flips to a brief
// "Copied" confirmation. Styled for the navy tray (on-dark tokens).

import { useState } from 'react';

export function ShareBasketButton({
  onShare,
  disabled,
  iconOnly,
}: {
  onShare: () => Promise<boolean> | boolean;
  disabled?: boolean;
  /** compact round icon button (label kept for screen readers / tooltip) */
  iconOnly?: boolean;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copied = state === 'copied';

  const click = async () => {
    let ok = false;
    try {
      ok = await onShare();
    } catch {
      ok = false;
    }
    // Always give feedback — a silent no-op on a blocked clipboard reads as broken.
    setState(ok ? 'copied' : 'failed');
    // Event-handler timeout (not render) — safe; resets the confirmation.
    setTimeout(() => setState('idle'), ok ? 1800 : 2600);
  };

  return (
    <button
      type="button"
      onClick={click}
      disabled={disabled}
      title="Copy a shareable link to this basket"
      aria-label={
        state === 'failed'
          ? 'Couldn’t copy the share link'
          : copied
            ? 'Share link copied'
            : 'Share basket'
      }
      className={`inline-flex items-center gap-1.5 rounded-full bg-on-dark-soft/15 text-xs text-on-dark-soft transition-colors hover:text-on-dark disabled:cursor-not-allowed disabled:opacity-40 ${
        iconOnly ? 'h-8 w-8 justify-center' : 'px-2.5 py-1'
      }`}
    >
      {state === 'failed' ? (
        <span className="text-error">{iconOnly ? '!' : 'Couldn’t copy'}</span>
      ) : copied ? (
        <>
          <svg
            viewBox="0 0 24 24"
            className="h-3.5 w-3.5 text-coral"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m20 6-11 11-5-5" />
          </svg>
          {!iconOnly && 'Copied'}
        </>
      ) : (
        <>
          <svg
            viewBox="0 0 24 24"
            className="h-3.5 w-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="18" cy="5" r="3" />
            <circle cx="6" cy="12" r="3" />
            <circle cx="18" cy="19" r="3" />
            <path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4" />
          </svg>
          {!iconOnly && 'Share'}
        </>
      )}
    </button>
  );
}

export default ShareBasketButton;
