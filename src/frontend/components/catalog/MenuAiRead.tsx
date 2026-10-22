'use client';

// The AI read shown the moment a restaurant menu opens (by tap or by chat):
// 2–3 lines from the real menu data — top rated / bestsellers, best value, veg
// options, what's unavailable — plus actionable chips ("Add the bestseller
// biryani", "… for 2"). The deterministic read (shared/foodAi.ts) renders
// instantly; /api/food-ai may replace it with an LLM phrasing that is guarded
// to use only Swiggy's numbers. A chip on a customisable dish opens the
// customizer with the AI's portion pick (e.g. "Serves 2" for "for 2").

import { useEffect, useMemo, useState } from 'react';
import type { FoodCartSelection, FoodRestaurant, MenuCategory, MenuItem } from '@/shared/types';
import { menuInsights, type MenuChip } from '@/shared/foodAi';
import { FoodCustomizer } from './FoodCustomizer';

// one AI phrasing per menu page per session (and one request in flight)
const phrased = new Map<string, string[]>();
const pending = new Map<string, Promise<string[] | null>>();

/** /api/food-ai menuRead — only the fields the read needs (no descriptions / images). */
async function fetchRead(restaurant: FoodRestaurant | undefined, categories: MenuCategory[]): Promise<string[] | null> {
  try {
    const res = await fetch('/api/food-ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'menuRead',
        restaurant,
        categories: categories.map((c) => ({
          title: c.title,
          items: c.items.slice(0, 12).map((i) => ({ ...i, description: '', imageUrl: '', customization: undefined })),
        })),
      }),
    });
    const data = (await res.json().catch(() => ({}))) as { lines?: string[]; source?: string };
    return res.ok && data.source === 'ai' && data.lines?.length ? data.lines : null;
  } catch {
    return null; // keep the deterministic read
  }
}

export function MenuAiRead({
  restaurant,
  categories,
  onAdd,
  addressId,
}: {
  restaurant?: FoodRestaurant;
  categories: MenuCategory[];
  onAdd: (item: MenuItem, selection?: FoodCartSelection) => void;
  addressId?: string;
}) {
  const insights = useMemo(() => menuInsights(categories, restaurant), [categories, restaurant]);
  const key = `${restaurant?.id ?? ''}|${insights.facts.length}|${categories.length}`;
  const [aiLines, setAiLines] = useState<string[] | null>(() => phrased.get(key) ?? null);
  const [open, setOpen] = useState<{ item: MenuItem; hint?: string } | null>(null);
  const [added, setAdded] = useState<string | null>(null);

  useEffect(() => {
    if (!insights.lines.length || phrased.has(key)) return;
    let alive = true;
    let job = pending.get(key);
    if (!job) {
      job = fetchRead(restaurant, categories).then((lines) => {
        if (lines) phrased.set(key, lines);
        pending.delete(key);
        return lines;
      });
      pending.set(key, job);
    }
    void job.then((lines) => {
      if (alive && lines) setAiLines(lines);
    });
    return () => {
      alive = false;
    };
  }, [key, insights.lines.length, restaurant, categories]);

  if (!insights.lines.length) return null;
  const lines = aiLines ?? insights.lines;
  const byId = new Map(categories.flatMap((c) => c.items).map((i) => [i.id, i] as const));

  const tap = (chip: MenuChip) => {
    const item = byId.get(chip.itemId);
    if (!item) return;
    if (item.hasVariants || item.hasAddons) {
      setOpen({ item, hint: chip.hint });
      return;
    }
    onAdd(item);
    setAdded(item.name);
  };

  return (
    <div className="mb-3 rounded-xl border border-coral/25 bg-coral/[0.04] px-3 py-2.5">
      <p className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-coral">
        <span aria-hidden="true">✦</span> AI read of this menu
      </p>
      {lines.map((l) => (
        <p key={l} className="text-[12.5px] leading-snug text-body">
          {l}
        </p>
      ))}
      {insights.chips.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {insights.chips.map((c) => (
            <button
              key={`${c.itemId}-${c.label}`}
              type="button"
              onClick={() => tap(c)}
              disabled={!byId.get(c.itemId)?.inStock}
              className="rounded-full border border-coral/40 bg-canvas px-2.5 py-1 text-[11px] font-medium text-coral transition-colors hover:bg-coral/10 disabled:opacity-50"
            >
              {c.label}
            </button>
          ))}
        </div>
      )}
      {added && <p className="mt-1.5 text-[11px] text-success-ink">Added {added} to your cart ✓</p>}
      {open && (
        <FoodCustomizer
          item={open.item}
          addressId={addressId}
          variantHint={open.hint}
          onCancel={() => setOpen(null)}
          onConfirm={(selection) => {
            onAdd(open.item, selection);
            setAdded(open.item.name);
            setOpen(null);
          }}
        />
      )}
    </div>
  );
}

export default MenuAiRead;
