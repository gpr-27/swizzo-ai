'use client';

// The AI layer of the Food cart tray (dark surface), all from Swiggy's real
// cart data:
//  - FoodLineAddons: the line's add-ons from get_food_cart `valid_addons` (the
//    ONLY add-ons valid for the chosen portion), the AI's pre-selection note,
//    and an editor (min / max respected) — saved via update_food_cart.
//  - FoodCouponReportView: "Applied X — saves ₹Y" from the automatic coupon
//    pass, plus Swiggy's reason for every other coupon.
//  - FoodBillRead / FoodAiRead: a plain-language bill breakdown (+ Swiggy's own
//    nudges only); FoodAiRead folds it, the coupon report and Analyse into one
//    expandable line so the order lines stay visible.
//  - FoodCheckoutReady: one compact "Ready to order" row — the payment methods
//    get_payment_options returns and what still blocks placement. The user
//    still taps Place order; nothing here places it.

import { useEffect, useMemo, useState } from 'react';
import type {
  FoodAddonGroup,
  FoodCart,
  FoodCartLine,
  FoodCartSelection,
  FoodCouponReport,
  PaymentOptionsPayload,
} from '@/shared/types';
import { FOOD_ORDER_CAP } from '@/shared/types';
import { explainFoodBill, groupMax } from '@/shared/foodAi';
import { foodActions, useFoodContext } from '@/frontend/state/foodActions';
import { InfoToggle, PayMethodsRow, type PayMethod } from './trayBits';

function inr(n: number): string {
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

/* ------------------------------ line add-ons ------------------------------- */

export function FoodLineAddons({ line, disabled }: { line: FoodCartLine; disabled?: boolean }) {
  const groups = line.validAddons ?? [];
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Record<string, string[]>>({});

  const current = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const a of line.selection?.addons ?? []) out[a.groupId] = [...(out[a.groupId] ?? []), a.choiceId];
    return out;
  }, [line.selection]);

  if (!groups.length && !line.aiNote) return null;

  const start = () => {
    setPicked(current);
    setOpen(true);
  };
  const toggle = (g: FoodAddonGroup, id: string) =>
    setPicked((p) => {
      const cur = p[g.groupId] ?? [];
      if (cur.includes(id)) return { ...p, [g.groupId]: cur.filter((x) => x !== id) };
      // a single-choice group swaps; otherwise respect maxAddons
      if (groupMax(g) === 1) return { ...p, [g.groupId]: [id] };
      if (cur.length >= groupMax(g)) return p;
      return { ...p, [g.groupId]: [...cur, id] };
    });
  const missing = groups.filter((g) => g.min > 0 && (picked[g.groupId]?.length ?? 0) < g.min);
  const save = () => {
    if (missing.length) return;
    const addons: FoodCartSelection['addons'] = groups.flatMap((g) =>
      (picked[g.groupId] ?? []).flatMap((id) => {
        const c = g.choices.find((x) => x.id === id);
        return c ? [{ groupId: g.groupId, choiceId: c.id, name: c.name, price: c.price }] : [];
      }),
    );
    foodActions()?.setLineSelection(
      line.menuItemId,
      { format: line.selection?.format ?? 'none', variants: line.selection?.variants ?? [], addons },
      'Your add-on choice — from Swiggy’s options for this portion.',
    );
    setOpen(false);
  };

  return (
    <div className="mt-1">
      {line.aiNote && !open && <p className="text-[11px] leading-snug text-coral/90">✦ {line.aiNote}</p>}
      {groups.length > 0 && !open && (
        <button
          type="button"
          onClick={start}
          disabled={disabled}
          className="mt-0.5 text-[11px] font-semibold text-on-dark-soft underline-offset-2 hover:text-on-dark hover:underline disabled:opacity-40"
        >
          Customise add-ons
        </button>
      )}
      {open && (
        <div className="mt-1.5 space-y-2 rounded-md border border-on-dark-soft/20 p-2">
          {groups.map((g) => {
            const rule =
              g.min > 0 && g.max > 0 ? `pick ${g.min}–${g.max}` : g.min > 0 ? `pick ${g.min}+` : g.max > 0 ? `up to ${g.max}` : 'optional';
            return (
              <fieldset key={g.groupId}>
                <legend className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-on-dark-soft">
                  {g.name.replace(/[-.\s]+$/, '') || 'Add-ons'} <span className="normal-case tracking-normal">({rule})</span>
                </legend>
                <div className="flex flex-wrap gap-1">
                  {g.choices.map((c) => {
                    const on = (picked[g.groupId] ?? []).includes(c.id);
                    return (
                      <button
                        key={c.id}
                        type="button"
                        aria-pressed={on}
                        onClick={() => toggle(g, c.id)}
                        className={`rounded-full border px-2 py-0.5 text-[11px] ${
                          on ? 'border-coral bg-coral text-on-primary' : 'border-on-dark-soft/30 text-on-dark hover:border-coral'
                        }`}
                      >
                        {c.name} · {c.price > 0 ? `+${inr(c.price)}` : 'free'}
                      </button>
                    );
                  })}
                </div>
              </fieldset>
            );
          })}
          {missing.length > 0 && (
            <p className="text-[10px] text-amber-300">Pick {missing[0].min} in {missing[0].name.replace(/[-.\s]+$/, '')}.</p>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setOpen(false)} className="text-[11px] text-on-dark-soft hover:text-on-dark">
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={missing.length > 0}
              className="rounded-full bg-coral px-2.5 py-0.5 text-[11px] font-semibold text-on-primary disabled:opacity-50"
            >
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------ coupon report ------------------------------ */

/** The automatic coupon pass: "Applied X — saves ₹Y" + Swiggy's reason for every other coupon. */
export function FoodCouponReportView({ report }: { report?: FoodCouponReport }) {
  const [why, setWhy] = useState(false);
  if (!report || (!report.applied && !report.others.length && !report.message)) return null;
  return (
    <div className="text-[12px] leading-snug">
      {report.applied ? (
        <p className="text-accent-teal">
          <span className="font-semibold">{report.auto ? '✦ AI applied ' : 'Applied '}</span>
          <span className="font-semibold tracking-wide">{report.applied.code}</span> — saves {inr(report.applied.savings)}
          {report.applied.title ? <span className="block text-[11px] text-on-dark-soft">{report.applied.title}</span> : null}
        </p>
      ) : report.message ? (
        <p className="text-on-dark-soft">✦ {report.message}</p>
      ) : null}
      {report.others.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setWhy((w) => !w)}
            aria-expanded={why}
            className="mt-0.5 text-[11px] font-semibold text-on-dark-soft hover:text-on-dark"
          >
            {why ? 'Hide' : `Why not the other ${report.others.length === 1 ? 'coupon' : `${report.others.length} coupons`}?`}
          </button>
          {why && (
            <ul className="mt-1 space-y-0.5 text-[11px] text-on-dark-soft">
              {report.others.map((o) => (
                <li key={o.code}>
                  <span className="font-semibold tracking-wide text-on-dark">{o.code}</span>
                  {o.title ? ` (${o.title})` : ''}: {o.reason}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

/* -------------------------------- bill read -------------------------------- */

/** What the bill read and the Ready card key on (Swiggy's numbers only). */
function billKey(cart: FoodCart): string {
  return [cart.toPay, cart.itemTotal, cart.taxes, cart.deliveryCharge, cart.appliedCoupon?.code ?? '', cart.items.length].join('|');
}

const billCache = new Map<string, string[]>();

/** Plain-language bill lines (AI phrasing when it lands, else deterministic) + Swiggy's own nudges. */
function useFoodBillRead(cart: FoodCart): { lines: string[]; nudges: string[] } {
  const read = useMemo(() => explainFoodBill(cart), [cart]);
  const key = billKey(cart);
  const [ai, setAi] = useState<{ key: string; lines: string[] } | null>(null);

  useEffect(() => {
    if (!read.lines.length || billCache.has(key)) return;
    let alive = true;
    // wait for the cart to settle before asking for a phrasing
    const t = setTimeout(async () => {
      try {
        const res = await fetch('/api/food-ai', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'billRead',
            cart: { ...cart, items: cart.items.map((l) => ({ ...l, imageUrl: '', validAddons: undefined })) },
          }),
        });
        const data = (await res.json().catch(() => ({}))) as { lines?: string[]; source?: string };
        if (res.ok && data.source === 'ai' && data.lines?.length) {
          billCache.set(key, data.lines);
          if (alive) setAi({ key, lines: data.lines });
        }
      } catch {
        /* keep the deterministic read */
      }
    }, 1200);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [key, read.lines.length, cart]);

  if (!read.lines.length) return { lines: [], nudges: read.nudges };
  const lines = billCache.get(key) ?? (ai?.key === key ? ai.lines : null) ?? read.lines;
  return { lines, nudges: read.nudges };
}

export function FoodBillRead({ cart }: { cart: FoodCart }) {
  const { lines, nudges } = useFoodBillRead(cart);
  if (!lines.length) return null;
  return (
    <div className="mt-3 rounded-md bg-white/[0.03] px-3 py-2">
      <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-coral">✦ Your bill, explained</p>
      {lines.map((l) => (
        <p key={l} className="text-[12px] leading-snug text-on-dark-soft">
          {l}
        </p>
      ))}
      {nudges.map((n) => (
        <p key={n} className="mt-1 text-[11px] font-medium text-amber-300">
          Swiggy: {n}
        </p>
      ))}
    </div>
  );
}

/**
 * Swizzo's read of the Food cart, folded to ONE line ("₹X to pay · AI applied
 * CODE −₹Y · free delivery"); tap to see the coupon report (why not the
 * others), the plain-language bill and the Analyse action. Swiggy's own nudges
 * stay visible under the line.
 */
export function FoodAiRead({
  cart,
  onAnalyze,
  analyzeDisabled,
  sending,
}: {
  cart: FoodCart;
  onAnalyze?: () => void;
  analyzeDisabled?: boolean;
  sending?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const unsynced = cart.synced === false;
  const { lines, nudges } = useFoodBillRead(cart);
  const report = unsynced ? undefined : cart.couponReport;
  const applied = cart.appliedCoupon && cart.appliedCoupon.savings > 0 ? cart.appliedCoupon : null;
  const free = !unsynced && (cart.freeDeliveryApplied === true || cart.deliveryCharge === 0);
  const parts = unsynced
    ? ["Prices aren't confirmed by Swiggy yet"]
    : [
        `${inr(cart.toPay)} to pay`,
        report?.applied
          ? `${report.auto ? 'AI applied' : 'applied'} ${report.applied.code} −${inr(report.applied.savings)}`
          : applied
            ? `${applied.code} saves ${inr(applied.savings)}`
            : '',
        free ? 'free delivery' : '',
      ].filter(Boolean);
  const summary = parts.join(' · ');
  const hasMore = !!report || lines.length > 0 || !!onAnalyze;

  return (
    <section aria-label="AI order review" className="mt-1 rounded-xl border border-white/[0.08] bg-white/[0.03]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        disabled={!hasMore}
        className="flex w-full min-w-0 items-center gap-2 px-3 py-2.5 text-left"
      >
        <span className="shrink-0 text-coral" aria-hidden="true">✦</span>
        <span
          className={`min-w-0 flex-1 truncate text-[12.5px] ${unsynced ? 'text-amber-300' : 'text-on-dark'}`}
          title={summary}
          aria-live="polite"
        >
          {summary}
        </span>
        {hasMore && (
          <svg
            viewBox="0 0 24 24"
            className={`h-3.5 w-3.5 shrink-0 text-on-dark-soft transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        )}
      </button>
      {nudges.length > 0 && (
        <div className="-mt-1 space-y-0.5 px-3 pb-2">
          {nudges.map((n) => (
            <p key={n} className="truncate text-[11px] font-medium text-amber-300" title={n}>
              Swiggy: {n}
            </p>
          ))}
        </div>
      )}
      {open && (
        <div className="space-y-2 border-t border-white/[0.06] px-3 pb-3 pt-2">
          <FoodCouponReportView report={report} />
          {lines.length > 0 && (
            <div>
              <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-coral">Your bill, explained</p>
              {lines.map((l) => (
                <p key={l} className="text-[12px] leading-snug text-on-dark-soft">
                  {l}
                </p>
              ))}
            </div>
          )}
          {onAnalyze && (
            <button
              type="button"
              onClick={onAnalyze}
              disabled={analyzeDisabled}
              className="inline-flex items-center gap-1 rounded-full border border-coral/40 bg-coral/10 px-2.5 py-1 text-[11px] font-semibold text-coral transition-colors hover:border-coral/70 disabled:opacity-40"
            >
              <span aria-hidden="true">✦</span> {sending ? 'Analysing…' : 'Analyse my order with AI'}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/* ----------------------------- ready to order ------------------------------ */

const methodLabel = (m: { displayName?: string; name: string; groupName?: string }) => m.displayName || m.name || m.groupName || '';

/**
 * One compact "Ready to order" row — a status glyph, the payment methods
 * get_payment_options returns (icons, "+N more"), an ⓘ for how placing works,
 * and what still blocks placement. The user still taps Place order.
 */
export function FoodCheckoutReady({ cart, busy }: { cart: FoodCart; busy?: boolean }) {
  const { addressId } = useFoodContext();
  const [pay, setPay] = useState<{ key: string; options?: PaymentOptionsPayload; error?: string } | null>(null);
  const [info, setInfo] = useState(false);
  const key = `${addressId}|${billKey(cart)}`;
  const synced = cart.synced !== false && !busy;

  useEffect(() => {
    if (!synced || !addressId || !cart.items.length) return;
    let alive = true;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/payments/options?service=food&addressId=${encodeURIComponent(addressId)}`);
        const data = (await res.json().catch(() => ({}))) as { ok?: boolean; options?: PaymentOptionsPayload; message?: string };
        if (!alive) return;
        setPay(
          res.ok && data.options
            ? { key, options: data.options }
            : { key, error: data.message || "Couldn't load Swiggy's payment methods." },
        );
      } catch {
        if (alive) setPay({ key, error: "Couldn't load Swiggy's payment methods." });
      }
    }, 800);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [key, synced, addressId, cart.items.length]);

  if (!cart.items.length) return null;
  const blockers = [
    cart.synced === false ? "prices aren't confirmed by Swiggy yet" : '',
    cart.toPay > FOOD_ORDER_CAP ? `over Swiggy's ${inr(FOOD_ORDER_CAP)} limit` : '',
    cart.items.some((l) => l.inStock === false) ? 'a dish is out of stock' : '',
    !addressId ? 'no delivery address selected' : '',
  ].filter(Boolean);
  const opts = pay?.key === key ? pay.options : undefined;
  const methods: PayMethod[] = [];
  if (opts) {
    const seen = new Set<string>();
    const push = (label: string, iconUrl?: string, qr?: boolean) => {
      if (!label || seen.has(label)) return;
      seen.add(label);
      methods.push({ label, ...(iconUrl ? { iconUrl } : {}), ...(qr ? { qr } : {}) });
    };
    for (const m of opts.allMethods) push(methodLabel(m), m.iconUrl, m.isQr || m.kind === 'qr');
    if (opts.cod?.available) push(opts.cod.displayName || 'Cash on delivery');
    if (opts.swiggyMoney?.available) push(opts.swiggyMoney.displayName || 'Swiggy Money');
  }
  const ready = blockers.length === 0;
  const hint = 'Tap Place order to choose a method and confirm — nothing is ordered until you do.';

  return (
    <div className="mt-3" aria-label="Checkout readiness">
      <div className="flex min-w-0 items-center gap-1.5">
        <span
          title={ready ? 'Ready to order' : 'Almost ready'}
          className={`shrink-0 text-[12px] font-bold leading-none ${ready ? 'text-accent-teal' : 'text-amber-300'}`}
        >
          <span aria-hidden="true">{ready ? '✓' : '!'}</span>
          <span className="sr-only">{ready ? 'Ready to order' : 'Almost ready'}</span>
        </span>
        <span className="shrink-0 text-[11px] text-on-dark-soft">Pay with</span>
        <span className="min-w-0 flex-1">
          <PayMethodsRow
            methods={methods}
            emptyText={
              opts ? 'No methods returned by Swiggy' : pay?.key === key && pay.error ? pay.error : 'checking Swiggy…'
            }
          />
        </span>
        <InfoToggle open={info} onToggle={() => setInfo((v) => !v)} label="How placing the order works" text={hint} />
      </div>
      {!ready && <p className="mt-1 text-[11px] leading-snug text-amber-300">Before placing: {blockers.join('; ')}.</p>}
      {info && <p className="mt-1.5 rounded-lg bg-white/[0.04] px-2.5 py-2 text-[11px] leading-snug text-on-dark-soft">{hint}</p>}
    </div>
  );
}
