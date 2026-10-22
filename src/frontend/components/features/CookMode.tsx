'use client';

// Cook-with-me: a step-by-step cooking guide rendered in the chat. One step at a
// time with a progress bar, Prev/Next navigation, and a built-in countdown timer
// for steps that carry one (start / pause / reset). The Recipe Book's kitchen
// companion (launched from Tools → Recipe Book "Step Timer" → hook.cookWithMe).
//
// Timer state is reset by the navigation HANDLERS (goTo) — never by a
// setState-in-effect synced to the step index — so there's no render-phase write.
// While a timer runs we hold a screen Wake Lock (so the kitchen screen never
// dims) and play a soft chime the moment it reaches zero.

import { useCallback, useEffect, useRef, useState } from 'react';

export interface CookModeProps {
  steps: { text: string; seconds?: number }[];
}

function fmt(s: number): string {
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${m}:${ss.toString().padStart(2, '0')}`;
}

export function CookMode({ steps }: CookModeProps) {
  const [i, setI] = useState(0);
  const [remaining, setRemaining] = useState(steps[0]?.seconds ?? 0);
  const [running, setRunning] = useState(false);
  const audioRef = useRef<AudioContext | null>(null);

  // A soft two-note WebAudio chime when a step timer hits zero. Best-effort:
  // silently no-ops where audio is unavailable or blocked.
  const playChime = useCallback(async () => {
    try {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctx) return;
      const ctx = audioRef.current ?? (audioRef.current = new Ctx());
      if (ctx.state === 'suspended') await ctx.resume();
      const now = ctx.currentTime;
      [880, 1320].forEach((freq, n) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        const t = now + n * 0.18;
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(0.18, t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.55);
      });
    } catch {
      /* audio not available — stay silent */
    }
  }, []);

  // Move to a step and reset its timer here (in the handler), not in an effect.
  const goTo = useCallback(
    (next: number) => {
      const clamped = Math.max(0, Math.min(steps.length - 1, next));
      setI(clamped);
      setRemaining(steps[clamped]?.seconds ?? 0);
      setRunning(false);
    },
    [steps],
  );

  // Tick the countdown while running. When it reaches zero we defer the
  // stop + chime out of the state updater (queueMicrotask) so the updater stays
  // pure and there's no setState-in-effect.
  useEffect(() => {
    if (!running) return;
    let fired = false;
    const id = setInterval(() => {
      setRemaining((r) => {
        if (r <= 1) {
          if (!fired) {
            fired = true;
            queueMicrotask(() => {
              setRunning(false);
              void playChime();
            });
          }
          return 0;
        }
        return r - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [running, playChime]);

  // Keep the screen awake (Wake Lock) only while a timer is actively running.
  useEffect(() => {
    if (!running) return;
    const nav = navigator as Navigator & {
      wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> };
    };
    let sentinel: { release: () => Promise<void> } | null = null;
    const acquire = async () => {
      try {
        sentinel = (await nav.wakeLock?.request('screen')) ?? null;
      } catch {
        /* denied or unsupported — fine */
      }
    };
    void acquire();
    // Re-acquire when the tab returns to the foreground mid-timer.
    const onVisible = () => {
      if (document.visibilityState === 'visible' && running) void acquire();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      void sentinel?.release().catch(() => {});
    };
  }, [running]);

  // Tear down the audio context on unmount.
  useEffect(() => {
    return () => {
      void audioRef.current?.close().catch(() => {});
    };
  }, []);

  if (steps.length === 0) return null;

  const total = steps.length;
  // Guard against the steps list shrinking under us (a re-streamed turn).
  const step = steps[Math.min(i, total - 1)];
  const last = i >= total - 1;
  const timeUp = !!step.seconds && remaining === 0;

  return (
    <section
      aria-label="Cook with me — step-by-step guide"
      className="animate-rise rounded-lg border border-hairline bg-canvas p-5"
    >
      {/* Header + progress */}
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 font-display text-lg leading-tight text-ink">
          <span aria-hidden="true">👨‍🍳</span> Cook with me
        </h3>
        <span className="text-xs text-muted-soft">
          Step {i + 1} of {total}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label="Recipe progress"
        aria-valuemin={1}
        aria-valuemax={total}
        aria-valuenow={i + 1}
        className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-surface-card"
      >
        <div
          className="h-full rounded-full bg-coral transition-all duration-300"
          style={{ width: `${((i + 1) / total) * 100}%` }}
        />
      </div>

      {/* Step */}
      <p aria-live="polite" className="mt-4 text-[17px] leading-relaxed text-ink">
        {step.text}
      </p>

      {/* Timer */}
      {step.seconds ? (
        <div className="mt-4 flex items-center gap-3">
          <span
            className={`font-display text-3xl tabular-nums leading-none ${
              timeUp ? 'text-error' : 'text-ink'
            }`}
          >
            {fmt(remaining)}
          </span>
          {timeUp ? (
            <div className="flex items-center gap-3">
              <span role="alert" className="text-sm font-medium text-error">
                Time&apos;s up!
              </span>
              <button
                type="button"
                onClick={() => {
                  setRemaining(step.seconds ?? 0);
                }}
                className="text-sm text-muted-soft transition-colors hover:text-ink"
              >
                Reset
              </button>
            </div>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setRunning((r) => !r)}
                className="rounded-md bg-coral px-3.5 py-1.5 text-sm font-medium text-on-primary transition-colors hover:bg-coral-active"
              >
                {running ? 'Pause' : 'Start'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setRunning(false);
                  setRemaining(step.seconds ?? 0);
                }}
                className="text-sm text-muted-soft transition-colors hover:text-ink"
              >
                Reset
              </button>
            </>
          )}
        </div>
      ) : null}

      {/* Navigation */}
      <div className="mt-5 flex items-center justify-between border-t border-hairline pt-3">
        <button
          type="button"
          onClick={() => goTo(i - 1)}
          disabled={i === 0}
          className="rounded-md px-3 py-1.5 text-sm text-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          ← Back
        </button>
        {last ? (
          <span className="text-sm font-medium text-teal-ink">
            🎉 Enjoy your meal!
          </span>
        ) : (
          <button
            type="button"
            onClick={() => goTo(i + 1)}
            className="rounded-md bg-coral px-4 py-1.5 text-sm font-medium text-on-primary transition-colors hover:bg-coral-active"
          >
            Next step →
          </button>
        )}
      </div>
    </section>
  );
}

export default CookMode;
