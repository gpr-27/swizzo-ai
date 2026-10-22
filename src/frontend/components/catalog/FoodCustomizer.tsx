'use client';

// Inline variant / add-on picker for a customisable dish. Swiggy's browse menu
// (get_restaurant_menu) carries no customization data, so when the dish didn't
// come from search_menu we load it with a restaurant-scoped search_menu
// (/api/dishes?restaurantId=…). The AI pre-selects a sensible default (the
// portion matching a hint like "for 2", else Swiggy's default; the fullest free
// required add-on) and says why; the user can change any of it. Dishes WITH
// portions follow Swiggy's documented flow: the portion is added first and the
// add-ons come from the cart's valid_addons for that portion (Swiggy returns
// one near-duplicate add-on group per portion — e.g. four required "Choose
// Accompaniment" groups at Behrouz — so offering them here was wrong). Groups
// are de-duplicated by name for display. Prices are shown exactly as
// Swiggy lists them (variantsV2 option prices are add-ons to the dish price,
// e.g. "Serves 2 · +₹430"); the running total is an estimate from those
// numbers — the cart shows Swiggy's real total after the add.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { FoodCartSelection, FoodItemCustomization, MenuItem } from '@/shared/types';
import { getFoodAddressId } from '@/frontend/state/foodAddress';
import { aiSelection, dedupeAddonGroups } from '@/shared/foodAi';

function inr(n: number): string {
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

type LoadState = { kind: 'ready'; customization: FoodItemCustomization } | { kind: 'error'; message: string };

export function FoodCustomizer({
  item,
  addressId,
  variantHint,
  onConfirm,
  onCancel,
}: {
  item: MenuItem;
  addressId?: string;
  // what the AI should match the portion to ("for 2", "Serves 2", "large")
  variantHint?: string;
  onConfirm: (selection: FoodCartSelection) => void;
  onCancel: () => void;
}) {
  const addr = addressId || getFoodAddressId();
  const needsFetch = !item.customization && Boolean(addr && item.restaurantId);
  const [loaded, setLoaded] = useState<LoadState | null>(null);

  useEffect(() => {
    if (!needsFetch) return;
    let alive = true;
    (async () => {
      try {
        const res = await fetch(
          `/api/dishes?q=${encodeURIComponent(item.name)}&restaurantId=${encodeURIComponent(
            item.restaurantId,
          )}&addressId=${encodeURIComponent(addr)}`,
        );
        const data = (await res.json().catch(() => ({}))) as { dishes?: MenuItem[]; error?: string };
        if (!alive) return;
        const match = data.dishes?.find((d) => d.id === item.id);
        setLoaded(
          res.ok && match?.customization
            ? { kind: 'ready', customization: match.customization }
            : { kind: 'error', message: data.error || "Swiggy didn't return the options for this dish." },
        );
      } catch {
        if (alive) setLoaded({ kind: 'error', message: "Couldn't load this dish's options." });
      }
    })();
    return () => {
      alive = false;
    };
  }, [needsFetch, item.name, item.id, item.restaurantId, addr]);

  const customization = item.customization ?? (loaded?.kind === 'ready' ? loaded.customization : null);
  const error = item.customization
    ? null
    : !needsFetch
      ? 'Pick a delivery address to see the options for this dish.'
      : loaded?.kind === 'error'
        ? loaded.message
        : null;

  // Swiggy flagged the dish customisable but returned nothing to choose →
  // add it straight away instead of showing an empty picker.
  const empty = !!customization && !hasCustomOptions(customization);
  const addedRef = useRef(false);
  useEffect(() => {
    if (!empty || addedRef.current) return;
    addedRef.current = true;
    onConfirm({ format: customization!.format, variants: [], addons: [] });
  }, [empty, customization, onConfirm]);
  if (empty) return <p className="mt-2 text-xs text-muted">Adding to cart…</p>;

  return (
    <div className="mt-3 rounded-xl border border-coral/30 bg-coral/[0.03] p-3 text-sm">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="font-semibold text-ink">Customise {item.name}</p>
        <button type="button" onClick={onCancel} className="text-xs text-muted hover:text-ink">
          Cancel
        </button>
      </div>

      {!customization && !error && <p className="text-xs text-muted">Loading options from Swiggy…</p>}
      {error && <p className="text-xs text-error">{error}</p>}
      {customization && (
        <CustomizerChoices customization={customization} basePrice={item.price} hint={variantHint} onConfirm={onConfirm} />
      )}
    </div>
  );
}

function CustomizerChoices({
  customization: raw,
  basePrice,
  hint,
  onConfirm,
}: {
  customization: FoodItemCustomization;
  basePrice: number;
  hint?: string;
  onConfirm: (selection: FoodCartSelection) => void;
}) {
  // the AI's default selection (+ why) over de-duplicated add-on groups
  const ai = useMemo(() => aiSelection(raw, hint), [raw, hint]);
  const deduped = useMemo(() => dedupeAddonGroups(raw.addonGroups), [raw]);
  // with portions, add-ons are picked from the cart's valid_addons after the add
  const addonsAfterAdd = ai.addonsAfterAdd;
  const customization = useMemo<FoodItemCustomization>(
    () => ({ ...raw, addonGroups: addonsAfterAdd ? [] : deduped.groups }),
    [raw, addonsAfterAdd, deduped],
  );
  // variant groupId -> chosen variation id (the AI's pick preselected)
  const [variants, setVariants] = useState<Record<string, string>>(() =>
    Object.fromEntries(ai.selection.variants.map((v) => [v.groupId, v.variationId])),
  );
  // addon groupId -> chosen choice ids (the AI's required picks preselected)
  const [addons, setAddons] = useState<Record<string, string[]>>(() => {
    const out: Record<string, string[]> = {};
    for (const a of ai.selection.addons) out[a.groupId] = [...(out[a.groupId] ?? []), a.choiceId];
    return out;
  });

  const problems = useMemo(() => {
    const out: string[] = [];
    for (const g of customization.variantGroups) {
      if (!variants[g.groupId]) out.push(`Choose ${g.name || 'an option'}`);
    }
    for (const g of customization.addonGroups) {
      const n = addons[g.groupId]?.length ?? 0;
      if (g.min > 0 && n < g.min) out.push(`Pick at least ${g.min} in ${g.name || 'add-ons'}`);
    }
    return out;
  }, [customization, variants, addons]);

  // Estimate only when every variant price is a known add-on (variantsV2).
  const estimate = useMemo(() => {
    if (!(basePrice > 0)) return null;
    let total = basePrice;
    for (const g of customization.variantGroups) {
      const c = g.choices.find((x) => x.id === variants[g.groupId]);
      if (!c || c.price === undefined) continue;
      if (!g.pricesAreAddOns) return null;
      total += c.price;
    }
    for (const g of customization.addonGroups) {
      const picked = (addons[g.groupId] ?? []).map((id) => g.choices.find((x) => x.id === id)?.price ?? 0);
      // maxFreeAddons: the first N picks in this group are free
      const paid = g.maxFree ? [...picked].sort((a, b) => a - b).slice(g.maxFree) : picked;
      total += paid.reduce((a, b) => a + b, 0);
    }
    return total;
  }, [basePrice, customization, variants, addons]);

  const toggleAddon = (groupId: string, choiceId: string, max: number) => {
    setAddons((prev) => {
      const cur = prev[groupId] ?? [];
      if (cur.includes(choiceId)) return { ...prev, [groupId]: cur.filter((x) => x !== choiceId) };
      if (max > 0 && cur.length >= max) return prev;
      return { ...prev, [groupId]: [...cur, choiceId] };
    });
  };

  const confirm = () => {
    if (problems.length) return;
    const selection: FoodCartSelection = {
      format: customization.format,
      variants: customization.variantGroups.flatMap((g) => {
        const choice = g.choices.find((c) => c.id === variants[g.groupId]);
        return choice ? [{ groupId: g.groupId, variationId: choice.id, name: choice.name }] : [];
      }),
      addons: customization.addonGroups.flatMap((g) =>
        (addons[g.groupId] ?? []).flatMap((id) => {
          const c = g.choices.find((x) => x.id === id);
          return c ? [{ groupId: g.groupId, choiceId: c.id, name: c.name, price: c.price }] : [];
        }),
      ),
    };
    onConfirm(selection);
  };

  return (
    <div className="space-y-3">
      {ai.reasons.length > 0 && (
        <p className="rounded-lg bg-coral/[0.06] px-2.5 py-1.5 text-[11px] text-body">
          <span className="font-semibold text-coral">✦ AI picked</span> {ai.reasons.join('; ')}. Change anything below.
        </p>
      )}
      {customization.variantGroups.map((g) => (
        <fieldset key={g.groupId}>
          <legend className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-soft">
            {g.name || 'Choose one'}
          </legend>
          <div className="flex flex-wrap gap-1.5">
            {g.choices.map((c) => {
              const on = variants[g.groupId] === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  disabled={!c.inStock}
                  aria-pressed={on}
                  onClick={() => setVariants((v) => ({ ...v, [g.groupId]: c.id }))}
                  className={`rounded-full border px-3 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                    on
                      ? 'border-coral bg-coral text-on-primary'
                      : 'border-hairline bg-canvas text-ink hover:border-coral'
                  }`}
                >
                  {c.name}
                  {c.price !== undefined && c.price > 0 ? ` · ${g.pricesAreAddOns ? '+' : ''}${inr(c.price)}` : ''}
                  {!c.inStock ? ' · sold out' : ''}
                </button>
              );
            })}
          </div>
        </fieldset>
      ))}

      {customization.addonGroups.map((g) => {
        const picked = addons[g.groupId] ?? [];
        const rule =
          g.min > 0 && g.max > 0
            ? `pick ${g.min}–${g.max}`
            : g.min > 0
              ? `pick at least ${g.min}`
              : g.max > 0
                ? `up to ${g.max}`
                : 'optional';
        return (
          <fieldset key={g.groupId}>
            <legend className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-soft">
              {g.name || 'Add-ons'}{' '}
              <span className="normal-case tracking-normal">
                ({rule}
                {g.maxFree ? ` · first ${g.maxFree} free` : ''})
              </span>
            </legend>
            <div className="flex flex-wrap gap-1.5">
              {g.choices.map((c) => {
                const on = picked.includes(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggleAddon(g.groupId, c.id, g.max)}
                    className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                      on
                        ? 'border-coral bg-coral text-on-primary'
                        : 'border-hairline bg-canvas text-ink hover:border-coral'
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

      {addonsAfterAdd && (
        <p className="text-[11px] text-muted">
          Add-ons ({deduped.groups.map((g) => g.name.replace(/[-.\s]+$/, '')).filter(Boolean).slice(0, 4).join(', ')}
          {deduped.groups.length > 4 ? '…' : ''}) depend on the portion. Once it&apos;s in your cart, Swiggy confirms which
          apply to it — I&apos;ll pick any required one (e.g. the free accompaniment) and you can change it there.
        </p>
      )}

      {raw.variantGroups.length === 0 && raw.addonGroups.length === 0 && (
        <p className="text-xs text-muted">Swiggy lists no options for this dish.</p>
      )}

      {problems.length > 0 && <p className="text-[11px] text-muted">{problems[0]}.</p>}

      {estimate !== null && (
        <p className="text-[11px] text-muted">
          About <span className="font-semibold text-ink">{inr(estimate)}</span>{' '}each — Swiggy&apos;s cart confirms the price.
        </p>
      )}

      <button
        type="button"
        onClick={confirm}
        disabled={problems.length > 0}
        className="w-full rounded-lg bg-coral px-3 py-2 text-xs font-bold uppercase tracking-wider text-on-primary transition-colors hover:bg-coral-active disabled:cursor-not-allowed disabled:opacity-50"
      >
        Add to cart
      </button>
    </div>
  );
}

export default FoodCustomizer;

/** True when Swiggy returned at least one real variant or add-on choice. */
export function hasCustomOptions(c: FoodItemCustomization): boolean {
  return c.variantGroups.some((g) => g.choices.length > 0) || c.addonGroups.some((g) => g.choices.length > 0);
}
