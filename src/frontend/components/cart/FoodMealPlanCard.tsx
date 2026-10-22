'use client';

// The agent's one-sentence order ("dinner for 3 under ₹800, one veg") as ONE
// approvable proposal: every dish with its 1-line reason, the AI-picked portion
// / add-ons (resolved from Swiggy's scoped search_menu as soon as the card
// shows), and the estimated food total against the budget. Nothing touches the
// cart until the user taps "Approve all"; "Tweak" lets them change quantities,
// drop a dish, or ask the AI for a change in words.

import { useEffect, useMemo, useState } from 'react';
import type { FoodCartLine, FoodMealPlan } from '@/shared/types';
import { FOOD_ORDER_CAP } from '@/shared/types';
import { foodActions, useFoodContext } from '@/frontend/state/foodActions';

function inr(n: number): string {
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

interface ResolvedLine {
  line: Omit<FoodCartLine, 'quantity'>;
  quantity: number;
  note?: string;
  unavailable?: string;
}

type Status = 'pending' | 'approved' | 'dismissed';

export function FoodMealPlanCard({
  messageId,
  plan,
}: {
  messageId: string;
  plan: FoodMealPlan & { status?: Status };
}) {
  const { addressId } = useFoodContext();
  const [resolved, setResolved] = useState<ResolvedLine[] | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [failed, setFailed] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>(plan.status ?? 'pending');
  const [tweak, setTweak] = useState(false);
  const [qty, setQty] = useState<Record<string, number>>(() =>
    Object.fromEntries(plan.items.map((i) => [i.menuItemId, i.quantity])),
  );
  const [ask, setAsk] = useState('');

  // Resolve portions / add-ons once (read-only search_menu on the server).
  useEffect(() => {
    if (status !== 'pending' || !addressId) return;
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/api/food-ai', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'resolveMeal',
            addressId,
            restaurantId: plan.restaurantId,
            restaurantName: plan.restaurantName,
            items: plan.items,
          }),
        });
        const data = (await res.json().catch(() => ({}))) as { lines?: ResolvedLine[]; notes?: string[]; error?: string };
        if (!alive) return;
        if (!res.ok || !data.lines) {
          setFailed(data.error || "Couldn't check the dishes' options with Swiggy.");
          return;
        }
        setResolved(data.lines);
        setNotes(data.notes ?? []);
      } catch {
        if (alive) setFailed("Couldn't check the dishes' options with Swiggy.");
      }
    })();
    return () => {
      alive = false;
    };
  }, [addressId, plan, status]);

  const rows = useMemo(
    () =>
      plan.items.map((it) => {
        const r = resolved?.find((x) => x.line.menuItemId === it.menuItemId);
        return { it, r, unit: r?.line.price ?? it.price, q: qty[it.menuItemId] ?? 0 };
      }),
    [plan.items, resolved, qty],
  );
  const live = rows.filter((x) => x.q > 0 && !x.r?.unavailable);
  const estimate = live.reduce((s, x) => s + x.unit * x.q, 0);
  const overBudget = plan.budget ? estimate > plan.budget : false;
  const overCap = estimate > FOOD_ORDER_CAP;

  const approve = () => {
    const act = foodActions();
    if (!act || live.length === 0) return;
    act.applyMealPlan(
      live.map((x) => ({
        line: x.r ? { ...x.r.line, ...(x.r.note ? { aiNote: x.r.note } : {}) } : {
          menuItemId: x.it.menuItemId,
          name: x.it.name,
          imageUrl: x.it.imageUrl,
          veg: x.it.veg,
          price: x.it.price,
        },
        quantity: x.q,
      })),
      plan.restaurantId,
      plan.restaurantName,
    );
    setStatus('approved');
    act.setMealPlanStatus(messageId, 'approved');
  };

  const dismiss = () => {
    setStatus('dismissed');
    foodActions()?.setMealPlanStatus(messageId, 'dismissed');
  };

  const sendTweak = () => {
    const t = ask.trim();
    if (!t) return;
    const current = live.map((x) => `${x.it.name} x${x.q}`).join(', ');
    foodActions()?.sendChat(
      `Change the meal plan from ${plan.restaurantName} (${current}): ${t}. Re-plan the whole cart with MEAL / MEALITEM lines.`,
      t,
    );
    setAsk('');
  };

  const done = status !== 'pending';

  return (
    <div
      className={`mt-3.5 overflow-hidden rounded-xl border p-3.5 shadow-sm ${
        status === 'approved' ? 'border-success/30 bg-success/[0.04]' : 'border-coral/30 bg-coral/[0.04]'
      } ${status === 'dismissed' ? 'opacity-60' : ''}`}
    >
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-coral">
            <span aria-hidden="true">✦</span> AI-built order · {plan.title}
          </p>
          <p className="mt-0.5 text-[11px] text-muted">
            from <span className="font-medium text-ink">{plan.restaurantName}</span>
            {plan.people ? ` · for ${plan.people}` : ''}
            {plan.budget ? ` · budget ${inr(plan.budget)}` : ''}
          </p>
        </div>
        {status === 'approved' && (
          <span className="rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-medium text-success-ink">Added to cart ✓</span>
        )}
        {status === 'dismissed' && (
          <span className="rounded-full bg-surface-card px-2 py-0.5 text-[11px] text-muted-soft">Dismissed</span>
        )}
      </div>

      <ul className="space-y-2">
        {rows.map(({ it, r, unit, q }) => (
          <li
            key={it.menuItemId}
            className={`flex gap-3 rounded-lg border border-hairline/80 bg-canvas/80 px-3 py-2 ${q === 0 || r?.unavailable ? 'opacity-50' : ''}`}
          >
            <span className="h-11 w-11 shrink-0 overflow-hidden rounded-lg border border-hairline/50 bg-surface-soft">
              {it.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img decoding="async" src={it.imageUrl} alt="" className="h-full w-full object-cover" />
              ) : null}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span
                  className={`inline-block h-2.5 w-2.5 shrink-0 rounded-[2px] border ${it.veg ? 'border-success' : 'border-error'}`}
                  aria-label={it.veg ? 'Veg' : 'Non-veg'}
                  role="img"
                />
                <span className="truncate text-[13px] font-medium text-ink">{it.name}</span>
              </span>
              <span className="block text-[11px] text-body">
                {it.reason}
                {it.rating ? ` · ★${it.rating}` : ''}
                {it.bestseller ? ' · Bestseller' : ''}
              </span>
              {r?.note && <span className="block text-[11px] text-coral/90">{r.note}</span>}
              {r?.unavailable && <span className="block text-[11px] text-error">{r.unavailable}</span>}
              {!r && it.option && <span className="block text-[11px] text-muted-soft">Portion: {it.option}</span>}
            </span>
            <span className="flex shrink-0 flex-col items-end gap-1">
              <span className="font-display text-[14px] text-ink">{inr(unit * Math.max(q, 1))}</span>
              {tweak && !done ? (
                <span className="flex items-center gap-1.5">
                  <button
                    type="button"
                    aria-label={`Fewer ${it.name}`}
                    onClick={() => setQty((m) => ({ ...m, [it.menuItemId]: Math.max(0, (m[it.menuItemId] ?? 0) - 1) }))}
                    className="h-6 w-6 rounded-full border border-hairline text-xs text-ink hover:border-coral"
                  >
                    −
                  </button>
                  <span className="w-4 text-center text-xs tabular-nums">{q}</span>
                  <button
                    type="button"
                    aria-label={`More ${it.name}`}
                    onClick={() => setQty((m) => ({ ...m, [it.menuItemId]: Math.min(10, (m[it.menuItemId] ?? 0) + 1) }))}
                    className="h-6 w-6 rounded-full border border-hairline text-xs text-ink hover:border-coral"
                  >
                    +
                  </button>
                </span>
              ) : (
                <span className="text-[11px] text-muted">× {q}</span>
              )}
            </span>
          </li>
        ))}
      </ul>

      {[...(plan.notes ?? []), ...notes].map((n) => (
        <p key={n} className="mt-1.5 text-[11px] text-muted">
          {n}
        </p>
      ))}
      {failed && <p className="mt-1.5 text-[11px] text-error">{failed}</p>}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-hairline/70 pt-2.5">
        <p className="text-xs text-body">
          Food ≈ <span className="font-display text-[15px] text-ink">{inr(estimate)}</span>
          <span className="text-muted"> + taxes &amp; delivery — Swiggy&apos;s cart confirms the total</span>
          {!resolved && !failed && status === 'pending' && <span className="text-muted-soft"> · checking portions…</span>}
          {overBudget && <span className="block text-[11px] font-medium text-error">Over your {inr(plan.budget!)} budget — tweak it below.</span>}
          {overCap && <span className="block text-[11px] font-medium text-error">Over Swiggy&apos;s {inr(FOOD_ORDER_CAP)} order limit.</span>}
        </p>
        {!done && (
          <span className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={dismiss}
              className="rounded-full px-2.5 py-1 text-xs text-muted-soft hover:text-ink"
            >
              Dismiss
            </button>
            <button
              type="button"
              onClick={() => setTweak((t) => !t)}
              className="rounded-full border border-coral/40 px-3 py-1 text-xs font-medium text-coral hover:bg-coral/10"
            >
              {tweak ? 'Done' : 'Tweak'}
            </button>
            <button
              type="button"
              onClick={approve}
              disabled={live.length === 0 || overCap}
              className="rounded-full bg-coral px-3.5 py-1 text-xs font-semibold text-on-primary shadow-soft hover:bg-coral-active disabled:cursor-not-allowed disabled:opacity-50"
            >
              Approve all{live.length ? ` · ${live.reduce((s, x) => s + x.q, 0)}` : ''}
            </button>
          </span>
        )}
      </div>

      {tweak && !done && (
        <form
          className="mt-2 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            sendTweak();
          }}
        >
          <input
            value={ask}
            onChange={(e) => setAsk(e.target.value)}
            placeholder="Or tell me: “swap the dal for paneer”, “make it spicier”…"
            aria-label="Ask the AI to change the plan"
            maxLength={200}
            className="min-w-0 flex-1 rounded-full border border-hairline bg-canvas px-3 py-1.5 text-xs text-ink placeholder:text-muted-soft focus:border-coral focus:outline-none"
          />
          <button
            type="submit"
            disabled={!ask.trim()}
            className="shrink-0 rounded-full border border-coral/50 px-3 py-1 text-xs font-medium text-coral hover:bg-coral/10 disabled:opacity-50"
          >
            Ask AI
          </button>
        </form>
      )}
    </div>
  );
}

export default FoodMealPlanCard;
