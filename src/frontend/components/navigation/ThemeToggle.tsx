'use client';

// A calm light⇄dark switch that matches the TopNav's round icon buttons. The
// crescent moon and rayed sun cross-fade with a soft rotate/scale morph. State
// lives on <html data-theme>, persists to localStorage ('swiggy-theme'), and
// falls back to the OS preference. To dodge an SSR hydration mismatch we render
// a stable button (server + first client paint both assume the light default)
// and only reconcile the real theme inside a mount effect. The on-load apply is
// instant; only a user-initiated toggle adds the global `.theme-transition`
// crossfade (see globals.css) so a saved dark theme paints with no flash-fade.

import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark';
const STORAGE_KEY = 'swiggy-theme';

// Keep the mobile browser chrome (<meta name="theme-color">) in step with the
// in-app theme rather than the OS preference the static meta tags encode.
const THEME_COLOR: Record<Theme, string> = { light: '#faf9f5', dark: '#16140f' };

function applyTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
  document
    .querySelectorAll('meta[name="theme-color"]')
    .forEach((m) => m.setAttribute('content', THEME_COLOR[t]));
}

function readStored(): Theme | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'dark' || v === 'light' ? v : null;
  } catch {
    return null;
  }
}

export function ThemeToggle() {
  // Start on the light default so the server render and the first client paint
  // agree; the mount effect below corrects it before the browser paints again.
  const [theme, setTheme] = useState<Theme>('light');

  // Reconcile with the saved choice (or the OS preference) on mount — instantly,
  // with no crossfade, so a remembered dark theme doesn't visibly animate in.
  useEffect(() => {
    const stored = readStored();
    const initial: Theme =
      stored ??
      (window.matchMedia?.('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light');
    // Mount-time reconciliation from an external store (localStorage / OS pref),
    // not derived render state — runs once, so there's no cascading-render risk.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTheme(initial);
    applyTheme(initial);
  }, []);

  // If the user hasn't made an explicit choice, follow live OS theme changes.
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const onChange = (e: MediaQueryListEvent) => {
      if (readStored()) return; // an explicit pick always wins
      const next: Theme = e.matches ? 'dark' : 'light';
      setTheme(next);
      applyTheme(next);
    };
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);

  // The chat can change the theme too ("switch to dark mode" → the hook's
  // CONTROL handler persists it and fires `swiggy-theme-change`). Mirror it here
  // so the switch state never disagrees with the page.
  useEffect(() => {
    const onChat = (e: Event) => {
      const detail = (e as CustomEvent<unknown>).detail;
      const next: Theme | null =
        detail === 'dark' || detail === 'light' ? detail : readStored();
      if (!next) return;
      setTheme(next);
      applyTheme(next);
    };
    window.addEventListener('swiggy-theme-change', onChat);
    return () => window.removeEventListener('swiggy-theme-change', onChat);
  }, []);

  const toggle = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* private mode / storage blocked — keep the in-memory choice */
    }
    const root = document.documentElement;
    // Enable the one-shot global color crossfade only for this user action.
    root.classList.add('theme-transition');
    applyTheme(next);
    window.setTimeout(() => root.classList.remove('theme-transition'), 360);
  };

  const isDark = theme === 'dark';

  return (
    <button
      type="button"
      onClick={toggle}
      role="switch"
      aria-checked={isDark}
      aria-label="Dark theme"
      title={isDark ? 'Switch to light' : 'Switch to dark'}
      className="relative inline-flex h-9 w-9 items-center justify-center rounded-full border border-hairline text-body transition-colors hover:border-coral hover:text-coral"
    >
      <span className="relative h-5 w-5">
        {/* Sun — present in light, morphs out in dark */}
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className={`absolute inset-0 h-5 w-5 transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
            isDark
              ? 'rotate-90 scale-50 opacity-0'
              : 'rotate-0 scale-100 opacity-100'
          }`}
        >
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
        </svg>
        {/* Moon — present in dark, morphs out in light */}
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className={`absolute inset-0 h-5 w-5 transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
            isDark
              ? 'rotate-0 scale-100 opacity-100'
              : '-rotate-90 scale-50 opacity-0'
          }`}
        >
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
        </svg>
      </span>
    </button>
  );
}

export default ThemeToggle;
