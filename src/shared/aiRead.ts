// AI-everywhere for Dineout + Scenes — the pure, framework-free half (used by
// the result shortlists, details sheets, compare sheet, the /api/ai-read route,
// the model's tool summaries in runner.ts and scripts/verify-*.ts).
//
//  - rankDineoutShortlist / rankScenesShortlist: 2–3 ranked picks from the
//    loaded search results (every real field: rating value AND count, cost for
//    two, distance, headline / bank offers, perks, highlights, bookable).
//  - dineoutFacts / scenesFacts: the deterministic "AI read" of everything
//    Swiggy returned for one restaurant / event (summary + fact lines), also
//    the facts the model is given for its "Should I go?" line.
//  - dineoutCompareVerdict: "X wins on rating, Y on value" from the real rows.
//  - readNeeds / needsFit: what the user asked for (date night, family, veg,
//    drinks, budget…) matched against the restaurant's real amenities.
//
// REVIEWS: Swiggy's MCP returns NO review text for Dineout or Scenes — only the
// rating value and the number of ratings (checked against LIVE-SAMPLES.md and
// fields/*.md). Nothing here quotes, summarises or invents a review.

import type { DineoutRestaurant, ScenesEvent, ScenesShowListing } from "./types";

export const REVIEWS_NOTE = "Swiggy shares star ratings and rating counts only — no written reviews.";

/* -------------------------------- formatting ------------------------------- */

/** 93 → "93", 1052 → "1.1k", 2450 → "2.5k", 12000 → "12k". */
export function compactCount(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k >= 10 ? Math.round(k) : Math.round(k * 10) / 10}k`;
}

/** "4.6★ (1.1k ratings)" / "New on Swiggy (no ratings yet)". */
export function ratingText(r: Pick<DineoutRestaurant, "rating" | "ratingCount">, short = false): string {
  if (typeof r.rating !== "number" || r.rating <= 0) return short ? "New" : "New on Swiggy (no ratings yet)";
  const c = r.ratingCount ? ` (${compactCount(r.ratingCount)}${short ? "" : ` rating${r.ratingCount === 1 ? "" : "s"}`})` : "";
  return `${r.rating.toFixed(1)}★${c}`;
}

const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

export function costNumber(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const m = /₹\s*([\d,]+)/.exec(text);
  const n = m ? Number(m[1].replace(/,/g, "")) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function distanceNumber(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const m = /([\d.]+)\s*(km|m)\b/i.exec(text);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  return m[2].toLowerCase() === "m" ? n / 1000 : n;
}

/** The best % off Swiggy states anywhere on the card (headline, deals, offers). */
export function bestDiscount(r: DineoutRestaurant): number {
  const fromText = (s?: string) => Number(/(\d{1,2})\s*%/.exec(s ?? "")?.[1] ?? 0);
  return Math.max(
    0,
    fromText(r.offerHeadline?.title),
    ...(r.dealDetails ?? []).map((d) => d.discountPercentage ?? fromText(d.title)),
    ...(r.offerDetails ?? []).map((d) => d.discountPercentage ?? fromText(d.title)),
    ...(r.deals ?? []).map(fromText),
    ...(r.offers ?? []).map(fromText),
  );
}

/** The headline offer as one string ("[ONE] Flat 15% off on pre-booking"). */
export function headlineOffer(r: DineoutRestaurant): string | undefined {
  const h = r.offerHeadline;
  if (h) return [h.logoText ? `Swiggy ${h.logoText}` : "", h.title, h.subtitle].filter(Boolean).join(" ").trim();
  return r.deals?.[0] ?? r.offers?.[0];
}

/* ---------------------------------- needs ---------------------------------- */

export interface DiningNeeds {
  occasion?: "date" | "family" | "group" | "business";
  veg?: boolean;
  drinks?: boolean;
  rooftop?: boolean;
  music?: boolean;
  buffet?: boolean;
  quiet?: boolean;
  near?: boolean;
  cheap?: boolean;
  budgetForTwo?: number;
  guests?: number;
  /** "a date night" / "a family dinner" / … — for labels */
  label?: string;
}

/** What the user asked for, from their own words (chat asks + saved preferences). */
export function readNeeds(text: string | undefined): DiningNeeds {
  const t = (text ?? "").toLowerCase();
  const n: DiningNeeds = {};
  if (/\b(date night|dinner date|on a date|first date|romantic|anniversary|candle ?light|valentine|girlfriend|boyfriend|wife|husband)\b/.test(t)) {
    n.occasion = "date";
    n.label = "a date night";
  } else if (/\b(family|kids?|children|parents|toddler)\b/.test(t)) {
    n.occasion = "family";
    n.label = "a family meal";
  } else if (/\b(friends|group|gang|party|birthday|celebrat\w*|team|colleagues|office party)\b/.test(t)) {
    n.occasion = "group";
    n.label = "a group outing";
  } else if (/\b(business|client|meeting|work lunch)\b/.test(t)) {
    n.occasion = "business";
    n.label = "a business meal";
  }
  if (/\b(pure veg|vegetarian|veg only|\bveg\b|jain)\b/.test(t) && !/\bnon[- ]?veg\b/.test(t)) n.veg = true;
  if (/\b(drinks?|beer|brew\w*|pub|bar|cocktails?|wine|alcohol)\b/.test(t)) n.drinks = true;
  if (/\b(rooftop|terrace|open air|outdoor|view)\b/.test(t)) n.rooftop = true;
  if (/\b(live music|music|dj|band|karaoke)\b/.test(t)) n.music = true;
  if (/\bbuffet\b/.test(t)) n.buffet = true;
  if (/\b(quiet|calm|peaceful|cozy|cosy)\b/.test(t)) n.quiet = true;
  if (/\b(near ?by|near me|closest|walking distance)\b/.test(t)) n.near = true;
  if (/\b(cheap|budget|affordable|pocket|inexpensive|value)\b/.test(t)) n.cheap = true;
  const budget = /(?:under|below|within|less than|max|budget(?: of)?)\s*(?:rs\.?|₹|inr)?\s*([\d,]{3,6})/.exec(t);
  if (budget) n.budgetForTwo = Number(budget[1].replace(/,/g, ""));
  const guests = /\bfor\s+(\d{1,2})\b(?!\s*(?:pm|am|:|%|km))/.exec(t) ?? /\b(\d{1,2})\s+(?:people|guests|persons|of us)\b/.exec(t);
  if (guests) {
    const g = Number(guests[1]);
    if (g >= 1 && g <= 20) n.guests = g;
  }
  if (!n.guests && n.occasion === "date") n.guests = 2;
  return n;
}

export function hasNeeds(n: DiningNeeds): boolean {
  return Object.keys(n).some((k) => k !== "label" && k !== "guests");
}

const NEED_PATTERNS: { key: keyof DiningNeeds; re: RegExp; label: string }[] = [
  { key: "drinks", re: /alcohol|bar\b|beer|brew|cocktail|pub|wine/i, label: "drinks" },
  { key: "rooftop", re: /rooftop|terrace|outdoor|open air|view/i, label: "rooftop / outdoor" },
  { key: "music", re: /live music|\bdj\b|live performance|karaoke/i, label: "live music" },
  { key: "buffet", re: /buffet/i, label: "buffet" },
  { key: "veg", re: /pure veg|vegetarian|\bveg\b|vegan/i, label: "veg" },
];
const OCCASION_PATTERNS: Record<NonNullable<DiningNeeds["occasion"]>, RegExp> = {
  date: /romantic|rooftop|fine dining|candle|live music|alcohol served|cocktail|lounge|outdoor|terrace|wine|view/i,
  family: /family|kid|pure veg|play area|wheelchair|parking|high chair/i,
  group: /alcohol served|bar\b|brew|pub|live music|\bdj\b|sports|buffet|large|group|free beer|free drink/i,
  business: /free wifi|wifi|quiet|valet|fine dining|parking/i,
};

function corpus(r: DineoutRestaurant): string[] {
  return [
    ...(r.highlights ?? []),
    ...(r.amenities ?? []),
    ...(r.vendorHighlights ?? []),
    ...r.cuisines,
    ...(r.deals ?? []),
    r.name,
  ].filter(Boolean);
}

/** The restaurant's REAL facts that match what the user asked for. */
export function needsFit(r: DineoutRestaurant, n: DiningNeeds): { matched: string[]; misses: string[]; score: number } {
  const facts = corpus(r);
  const matched = new Set<string>();
  const misses: string[] = [];
  if (n.occasion) for (const f of facts) if (OCCASION_PATTERNS[n.occasion].test(f) && f !== r.name) matched.add(f);
  for (const p of NEED_PATTERNS) {
    if (!n[p.key]) continue;
    const hit = facts.find((f) => p.re.test(f));
    if (hit) matched.add(hit);
    else misses.push(p.label);
  }
  const cost = costNumber(r.costForTwo);
  if (n.budgetForTwo && cost !== undefined) {
    if (cost <= n.budgetForTwo) matched.add(`${r.costForTwo} (within ${inr(n.budgetForTwo)})`);
    else misses.push(`over your ${inr(n.budgetForTwo)} budget`);
  }
  const list = [...matched].filter((m) => !/reservation available|table booking|swiggypay/i.test(m));
  return { matched: list, misses, score: list.length - misses.length * 1.5 };
}

/* ------------------------------ Dineout ranking ----------------------------- */

/** Rating adjusted for how many people rated it (4.9 from 3 ratings < 4.6 from 1k). */
export function trustedRating(r: Pick<DineoutRestaurant, "rating" | "ratingCount">): number {
  if (typeof r.rating !== "number" || r.rating <= 0) return 3.6;
  const c = r.ratingCount ?? 0;
  const PRIOR = 3.9;
  const M = 40;
  return (r.rating * c + PRIOR * M) / (c + M);
}

export interface ShortlistItem {
  id: string;
  kind: "match" | "concierge" | "top" | "value" | "closest" | "soonest" | "shows";
  label: string; // "Best for a date night"
  name: string;
  line: string; // "4.6★ (1.1k) · ₹1,500 for two · 15% off · 1.7 km"
  why: string; // the real fields behind the pick
  bookable?: boolean;
  venueId?: string; // Scenes: venue-info cards share one eventId across venues
}

/** "4.6★ (1.1k) · ₹1,500 for two · 15% off · 1.7 km · table booking" */
export function dineoutLine(r: DineoutRestaurant): string {
  const pct = bestDiscount(r);
  const cost = costNumber(r.costForTwo);
  return [
    ratingText(r, true),
    cost !== undefined ? `${inr(cost)} for two` : r.costForTwo,
    pct ? `${pct}% off` : "",
    r.distance,
    r.bookable === false ? "walk-in only" : r.bookable ? "table booking" : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function valueScore(r: DineoutRestaurant): number {
  const cost = costNumber(r.costForTwo);
  return (
    bestDiscount(r) +
    (r.bankOffers?.length ? 3 : 0) +
    (r.vendorHighlights?.filter((v) => !/table booking/i.test(v)).length ?? 0) * 2 +
    (cost !== undefined ? Math.max(-10, Math.min(10, (2000 - cost) / 100)) : 0) +
    (trustedRating(r) - 4) * 8
  );
}

/**
 * 2–3 ranked picks from the loaded results — Best for <occasion> (when the user
 * said one), Top rated (count-weighted), Best value (offers + cost), Closest.
 * Walk-in-only places are skipped when bookable ones exist. Real fields only.
 */
export function rankDineoutShortlist(
  restaurants: DineoutRestaurant[],
  opts: { needs?: DiningNeeds; bestPicks?: Record<string, string>; max?: number } = {},
): ShortlistItem[] {
  const needs = opts.needs ?? {};
  const max = opts.max ?? 3;
  const bookable = restaurants.filter((r) => r.bookable !== false);
  const pool = bookable.length ? bookable : restaurants;
  if (pool.length < 2) return [];
  const out: ShortlistItem[] = [];
  const used = new Set<string>();
  const add = (r: DineoutRestaurant | undefined, kind: ShortlistItem["kind"], label: string, why: string) => {
    if (!r || used.has(r.id) || out.length >= max) return;
    used.add(r.id);
    out.push({ id: r.id, kind, label, name: r.name, line: dineoutLine(r), why, bookable: r.bookable });
  };

  // the concierge's own BEST mark (model) leads when it is in this list
  const best = pool.find((r) => opts.bestPicks?.[r.id]);
  if (best) add(best, "concierge", "Concierge pick", opts.bestPicks![best.id]);

  if (hasNeeds(needs)) {
    const scored = pool
      .map((r) => ({ r, fit: needsFit(r, needs) }))
      .sort((a, b) => b.fit.score - a.fit.score || trustedRating(b.r) - trustedRating(a.r));
    const top = scored[0];
    if (top && top.fit.matched.length) {
      add(
        top.r,
        "match",
        needs.label ? `Best for ${needs.label}` : "Best match",
        `${top.fit.matched.slice(0, 3).join(", ")} · ${ratingText(top.r)}`,
      );
    }
  }

  const byRating = [...pool].sort((a, b) => trustedRating(b) - trustedRating(a));
  const tr = byRating.find((r) => !used.has(r.id) && typeof r.rating === "number");
  if (tr) {
    add(
      tr,
      "top",
      "Top rated",
      tr.ratingCount ? `${tr.rating!.toFixed(1)}★ backed by ${compactCount(tr.ratingCount)} ratings` : `${tr.rating!.toFixed(1)}★ on Swiggy`,
    );
  }

  const byValue = [...pool].sort((a, b) => valueScore(b) - valueScore(a));
  const v = byValue.find((r) => !used.has(r.id));
  if (v) {
    const perks = (v.vendorHighlights ?? []).filter((p) => !/table booking/i.test(p));
    add(
      v,
      "value",
      "Best value",
      [headlineOffer(v), v.bankOffers?.[0] && v.bankOffers[0] !== v.offerHeadline?.title ? `${v.bankOffers[0]} bank offer` : "", perks.slice(0, 2).join(", "), v.costForTwo]
        .filter(Boolean)
        .join(" · ") || dineoutLine(v),
    );
  }

  const near = [...pool]
    .filter((r) => distanceNumber(r.distance) !== undefined)
    .sort((a, b) => distanceNumber(a.distance)! - distanceNumber(b.distance)!)
    .find((r) => !used.has(r.id));
  if (near) add(near, "closest", "Closest", `${near.distance} away · ${ratingText(near)}`);
  return out;
}

/** One line for the model's tool summary: the shortlist the UI shows above the cards. */
export function dineoutShortlistNote(restaurants: DineoutRestaurant[], needsText?: string): string {
  const list = rankDineoutShortlist(restaurants, { needs: readNeeds(needsText) });
  if (!list.length) return "";
  return `AI SHORTLIST (shown above the cards, each with a one-tap "Book best slot" button): ${list
    .map((s) => `${s.label}: ${s.name} [restaurantId=${s.id}] — ${s.line}`)
    .join(" ; ")}. Use concrete action chips such as "Book ${list[0].name} tomorrow 8 PM for ${readNeeds(needsText).guests ?? 2}".`;
}

/* ------------------------------ Dineout facts ------------------------------- */

export interface FactsRead {
  summary: string; // one deterministic sentence
  facts: string[]; // every real fact, short lines
}

/** Everything Swiggy returned for one restaurant, as an AI read (real fields only). */
export function dineoutFacts(r: DineoutRestaurant): FactsRead {
  const facts: string[] = [];
  const place = [r.area, r.locality].filter(Boolean).filter((x, i, a) => a.findIndex((y) => y!.toLowerCase().includes(x!.toLowerCase())) === i);
  facts.push(
    typeof r.rating === "number" && r.rating > 0
      ? `Rated ${r.rating.toFixed(1)}★ by ${r.ratingCount ? `${r.ratingCount.toLocaleString("en-IN")} diners` : "Swiggy diners"}`
      : "No ratings yet on Swiggy",
  );
  if (r.timings) facts.push(/open/i.test(r.timings) ? `${r.timings}` : `Timings: ${r.timings}`);
  const where = [r.distance ? `${r.distance} away` : "", place.join(", ")].filter(Boolean).join(" · ");
  if (where) facts.push(where);
  if (r.address) facts.push(`Address: ${r.address}`);
  if (r.costForTwo) facts.push(r.costForTwo);
  if (r.cuisines.length) facts.push(`Cuisines: ${r.cuisines.join(", ")}`);
  facts.push(
    r.bookable === false ? "Walk-in only — no table booking on Swiggy" : r.bookable ? "Takes table bookings on Swiggy" : "Table booking: check slots",
  );
  const head = headlineOffer(r);
  if (head) facts.push(`Headline offer: ${head}${r.offerHeadline?.subtext ? ` (${r.offerHeadline.subtext})` : ""}`);
  // deals grouped by Swiggy's slot group, with % off and cover charge
  const deals = [...(r.dealDetails ?? []), ...(r.offerDetails ?? [])].filter(
    (o, i, a) => a.findIndex((x) => x.title === o.title && x.description === o.description) === i,
  );
  const groups = new Map<string, string[]>();
  for (const d of deals) {
    const g = d.slotGroupName || "Offers";
    const bits = [
      d.discountPercentage ? `${d.discountPercentage}% off` : "",
      d.coverCharge !== undefined ? (d.coverCharge > 0 ? `${inr(d.coverCharge)} cover charge` : "no cover charge") : "",
      d.description,
    ].filter(Boolean);
    groups.set(g, [...(groups.get(g) ?? []), `${d.title}${bits.length ? ` (${bits.join(", ")})` : ""}`]);
  }
  for (const [g, items] of groups) facts.push(`${g}: ${items.join("; ")}`);
  if (!deals.length && r.deals?.length) facts.push(`Deals: ${r.deals.join("; ")}`);
  const bank = (r.bankOffers ?? []).filter((b) => b !== r.offerHeadline?.title);
  if (bank.length) facts.push(`Bank offers: ${bank.join("; ")}`);
  const perks = (r.vendorHighlights ?? []).filter((p) => !/table booking/i.test(p));
  if (perks.length) facts.push(`Perks: ${perks.join(", ")}`);
  const amen = [...new Set([...(r.amenities ?? []), ...(r.highlights ?? [])])].filter((a) => !/reservation available/i.test(a));
  if (amen.length) facts.push(`Amenities (${amen.length}): ${amen.join(", ")}`);
  if (r.menuImageGroups?.length) {
    facts.push(`Menu photos: ${r.menuImageGroups.map((g) => `${g.title} (${g.images.length} page${g.images.length === 1 ? "" : "s"})`).join(", ")}`);
  }
  const photos = new Set([...(r.mastheadImageUrls ?? []), ...(r.imageUrl ? [r.imageUrl] : [])]).size;
  if (photos) facts.push(`${photos} photo${photos === 1 ? "" : "s"} from Swiggy`);

  const pct = bestDiscount(r);
  const summary = [
    `${r.name}: ${ratingText(r)}`,
    r.cuisines.length ? r.cuisines.slice(0, 2).join(" & ") : "",
    place[0] ? `in ${place[0]}` : "",
    r.costForTwo ?? "",
    pct ? `up to ${pct}% off${r.offerHeadline?.subtitle ? ` ${r.offerHeadline.subtitle}` : ""}` : "",
    r.timings ?? "",
    r.distance ? `${r.distance} away` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return { summary, facts };
}

/** Deterministic "Should I go?" from the user's needs (used until / unless the model answers). */
export function dineoutFitLine(r: DineoutRestaurant, needs: DiningNeeds): string {
  if (r.bookable === false) return "Walk in only — you can't reserve it on Swiggy, so go early or pick a bookable place.";
  if (!hasNeeds(needs)) return "";
  const fit = needsFit(r, needs);
  const what = needs.label ?? "what you asked for";
  if (fit.matched.length && !fit.misses.length) return `Yes for ${what} — ${fit.matched.slice(0, 3).join(", ")}.`;
  if (fit.matched.length) return `Maybe for ${what} — ${fit.matched.slice(0, 2).join(", ")}, but not listed: ${fit.misses.join(", ")}.`;
  if (fit.misses.length) return `Probably not for ${what} — Swiggy doesn't list ${fit.misses.join(", ")} here.`;
  return "";
}

/* ------------------------------ Dineout compare ----------------------------- */

/** "Yuki wins on rating (4.5★ · 2.5k ratings) and distance (0.3 km); Quarter Peter on value (…)." */
export function dineoutCompareVerdict(rows: DineoutRestaurant[]): string {
  if (rows.length < 2) return "";
  const wins = new Map<string, string[]>();
  const win = (r: DineoutRestaurant | undefined, what: string) => {
    if (!r) return;
    wins.set(r.id, [...(wins.get(r.id) ?? []), what]);
  };
  const rated = rows.filter((r) => typeof r.rating === "number" && r.rating > 0);
  if (rated.length) {
    const r = [...rated].sort((a, b) => trustedRating(b) - trustedRating(a))[0];
    win(r, `rating (${r.rating!.toFixed(1)}★${r.ratingCount ? ` · ${compactCount(r.ratingCount)} ratings` : ""})`);
  }
  const v = [...rows].sort((a, b) => valueScore(b) - valueScore(a))[0];
  const pct = bestDiscount(v);
  win(v, `value (${[v.costForTwo, pct ? `${pct}% off` : ""].filter(Boolean).join(", ") || "offers"})`);
  const near = rows.filter((r) => distanceNumber(r.distance) !== undefined).sort((a, b) => distanceNumber(a.distance)! - distanceNumber(b.distance)!)[0];
  if (near && rows.filter((r) => distanceNumber(r.distance) !== undefined).length > 1) win(near, `distance (${near.distance})`);
  const parts = [...wins].map(([id, what]) => {
    const name = rows.find((r) => r.id === id)!.name;
    return `${name} on ${what.length > 1 ? `${what.slice(0, -1).join(", ")} and ${what[what.length - 1]}` : what[0]}`;
  });
  const walk = rows.filter((r) => r.bookable === false).map((r) => r.name);
  return `${parts[0].replace(" on ", " wins on ")}${parts.length > 1 ? `; ${parts.slice(1).join("; ")}` : ""}.${
    walk.length ? ` ${walk.join(", ")} ${walk.length === 1 ? "is" : "are"} walk-in only.` : ""
  }`;
}

/* --------------------------------- Scenes ---------------------------------- */

const MON = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "6th Nov • 06:00 PM onwards" → epoch ms (IST), year inferred from now. */
export function scenesDateMs(summary: string | undefined, nowMs = Date.now()): number | undefined {
  const m = /(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3})[a-z]*(?:\s*[•,-]?\s*(\d{1,2}):(\d{2})\s*([ap]m))?/i.exec(summary ?? "");
  if (!m) return undefined;
  const mon = MON.indexOf(m[2].toLowerCase());
  if (mon < 0) return undefined;
  let h = m[3] ? Number(m[3]) % 12 : 0;
  if (m[5]?.toLowerCase() === "pm") h += 12;
  const now = new Date(nowMs + 5.5 * 3600_000);
  let y = now.getUTCFullYear();
  if (mon < now.getUTCMonth() - 1) y++;
  return Date.UTC(y, mon, Number(m[1]), h, m[4] ? Number(m[4]) : 0) - 5.5 * 3600_000;
}

/** Soonest / Closest / Most shows (+ the concierge's BEST) from loaded event cards. */
export function rankScenesShortlist(
  events: ScenesEvent[],
  opts: { bestPicks?: Record<string, string>; nowMs?: number; max?: number } = {},
): ShortlistItem[] {
  const nowMs = opts.nowMs ?? Date.now();
  const max = opts.max ?? 3;
  if (events.length < 2) return [];
  const out: ShortlistItem[] = [];
  const used = new Set<string>();
  const line = (e: ScenesEvent) =>
    [e.dateSummary, [e.venueName, e.area].filter(Boolean).join(", "), e.priceText, e.distanceKm !== undefined ? `${e.distanceKm} km` : ""]
      .filter(Boolean)
      .join(" · ");
  const k = (e: ScenesEvent) => `${e.id}|${e.venueId ?? ""}`;
  const add = (e: ScenesEvent | undefined, kind: ShortlistItem["kind"], label: string, why: string) => {
    if (!e || used.has(k(e)) || out.length >= max) return;
    used.add(k(e));
    out.push({ id: e.id, venueId: e.venueId, kind, label, name: e.title, line: line(e), why });
  };
  const best = events.find((e) => opts.bestPicks?.[e.id]);
  if (best) add(best, "concierge", "Concierge pick", opts.bestPicks![best.id]);
  const dated = events
    .map((e) => ({ e, t: scenesDateMs(e.dateSummary, nowMs) }))
    .filter((x): x is { e: ScenesEvent; t: number } => x.t !== undefined && x.t >= nowMs - 6 * 3600_000)
    .sort((a, b) => a.t - b.t);
  const soon = dated.find((x) => !used.has(k(x.e)));
  if (soon) add(soon.e, "soonest", "Soonest", `Next show ${soon.e.dateSummary!.replace(/^next:\s*/i, "")}`);
  const near = events
    .filter((e) => e.distanceKm !== undefined && !used.has(k(e)))
    .sort((a, b) => a.distanceKm! - b.distanceKm!)[0];
  if (near) add(near, "closest", "Closest", `${near.distanceKm} km from you`);
  const many = events.filter((e) => (e.showCount ?? 0) > 1 && !used.has(k(e))).sort((a, b) => b.showCount! - a.showCount!)[0];
  if (many) add(many, "shows", "Most dates", `${many.showCount} shows at this venue — easy to fit in`);
  // fill with the next dated events when distance / show counts are unknown (search results)
  for (const x of dated) add(x.e, "soonest", "Coming up", `On ${x.e.dateSummary!.replace(/^next:\s*/i, "")}`);
  return out.length >= 2 ? out : [];
}

export function scenesShortlistNote(events: ScenesEvent[]): string {
  const list = rankScenesShortlist(events);
  if (!list.length) return "";
  return `AI SHORTLIST (shown above the cards, each with a one-tap "Best show" button): ${list
    .map((s) => `${s.label}: ${s.name} [eventId=${s.id}] — ${s.line}`)
    .join(" ; ")}.`;
}

const IST_DAY = (unix: number) =>
  new Date(unix * 1000).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" });

/** Everything Swiggy returned for one event listing, as an AI read (real fields only). */
export function scenesFacts(l: ScenesShowListing, nowMs = Date.now()): FactsRead {
  const facts: string[] = [];
  const shows = l.shows.filter((s) => !s.showTimeUnix || s.showTimeUnix * 1000 > nowMs);
  const onSale = shows.filter((s) => s.onSale);
  const tiers = onSale.flatMap((s) => s.tickets.filter((t) => t.onSale && t.price !== undefined));
  const prices = tiers.map((t) => t.price!);
  const lo = prices.length ? Math.min(...prices) : l.startPrice;
  const hi = prices.length ? Math.max(...prices) : undefined;
  const about = [l.seating, l.duration, l.ageGroup, l.languages?.map((x) => x.charAt(0).toUpperCase() + x.slice(1)).join(", ")].filter(Boolean);
  if (about.length) facts.push(about.join(" · "));
  if (l.category) facts.push(`Category: ${l.category}`);
  const venue = [l.venueName, l.venueArea, l.city].filter(Boolean).join(", ");
  if (venue || l.venueDistanceKm !== undefined) {
    facts.push([venue, l.venueDistanceKm !== undefined ? `${l.venueDistanceKm} km from you` : ""].filter(Boolean).join(" · "));
  }
  if (l.runFromUnix || l.runUntilUnix) {
    facts.push(
      `Runs ${l.runFromUnix ? IST_DAY(l.runFromUnix) : ""}${l.runUntilUnix ? ` – ${IST_DAY(l.runUntilUnix)}` : ""}${l.recurring ? " (recurring)" : ""}`.replace("Runs  –", "Runs until"),
    );
  } else if (l.recurring) facts.push("A recurring event");
  const dateKeys = [...new Set(shows.map((s) => s.date).filter(Boolean))];
  if (shows.length) {
    facts.push(
      `${onSale.length} of ${shows.length} show${shows.length === 1 ? "" : "s"} on sale across ${dateKeys.length || 1} date${dateKeys.length === 1 ? "" : "s"}${
        onSale[0] ? ` — next ${onSale[0].showTimeIst}` : ""
      }`,
    );
  }
  if (lo !== undefined) facts.push(hi !== undefined && hi !== lo ? `Tickets ${inr(lo)}–${inr(hi)}` : lo === 0 ? "Free entry" : `Tickets from ${inr(lo)}`);
  const tierNames = [...new Set(tiers.map((t) => `${t.title}${t.price !== undefined ? ` ${t.price === 0 ? "free" : inr(t.price)}` : ""}${t.originalPrice ? ` (was ${inr(t.originalPrice)})` : ""}${t.coverCharge ? ` + ${inr(t.coverCharge)} cover` : ""}`))];
  if (tierNames.length) facts.push(`Tiers: ${tierNames.slice(0, 6).join("; ")}`);
  const terms = [...new Set(tiers.map((t) => t.tnc).filter(Boolean))] as string[];
  if (terms.length) facts.push(`Ticket terms: ${terms.slice(0, 3).join("; ").replace(/\n/g, "; ")}`);
  const next = onSale[0];
  if (next?.availableSeats !== undefined) facts.push(`${next.availableSeats} seat${next.availableSeats === 1 ? "" : "s"} left for the next show`);
  const dateSeats = (l.dates ?? []).filter((d) => d.available !== undefined);
  if (dateSeats.length) facts.push(`Seats by date: ${dateSeats.slice(0, 5).map((d) => `${d.date} ${d.onSale ? d.available : "sold out"}`).join(", ")}`);
  if (next?.minGuests !== undefined && next.maxGuests !== undefined) facts.push(`${next.minGuests}–${next.maxGuests} tickets per booking`);
  if (next?.durationMin) facts.push(`Each show runs ${next.durationMin} min`);
  if (l.rewards) facts.push(`Offer: ${l.rewards}`);
  if (l.artists?.length) facts.push(`Artists: ${l.artists.join(", ")}`);
  if (l.organizer) facts.push(`By ${l.organizer}`);
  if (l.tour) facts.push(`Part of ${l.tour}`);
  if (l.tags?.length) facts.push(`Tags: ${l.tags.join(", ")}`);
  if (l.thingsToRemember?.length) facts.push(`Remember: ${l.thingsToRemember.join("; ")}`);
  const summary = [
    l.eventTitle,
    about.slice(0, 3).join(", "),
    l.venueName ? `at ${l.venueName}` : "",
    lo !== undefined ? (lo === 0 ? "free" : `from ${inr(lo)}`) : "",
    next ? `next ${next.showTimeIst}` : "",
    next?.availableSeats !== undefined ? `${next.availableSeats} seats left` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return { summary, facts };
}

/** "Should I go?" for an event from the user's words (age / language / budget / kids). */
export function scenesFitLine(l: ScenesShowListing, needsText: string | undefined): string {
  const t = (needsText ?? "").toLowerCase();
  if (!t.trim()) return "";
  const notes: string[] = [];
  const adultsOnly = /18|21|adult/i.test(l.ageGroup ?? "");
  if (/\b(kids?|children|family|toddler)\b/.test(t)) {
    if (adultsOnly) return `Probably not with kids — Swiggy lists it as ${l.ageGroup}.`;
    if (/all ages/i.test(l.ageGroup ?? "")) notes.push("open to all ages");
  }
  const lang = (l.languages ?? []).find((x) => t.includes(x.toLowerCase()));
  if (lang) notes.push(`in ${lang.charAt(0).toUpperCase() + lang.slice(1)}`);
  const budget = /(?:under|below|within|budget(?: of)?)\s*(?:rs\.?|₹)?\s*([\d,]{2,6})/.exec(t);
  const prices = l.shows.flatMap((s) => s.tickets.filter((x) => x.onSale && x.price !== undefined).map((x) => x.price!));
  if (budget && prices.length) {
    const b = Number(budget[1].replace(/,/g, ""));
    const lo = Math.min(...prices);
    if (lo > b) return `Probably not on budget — the cheapest ticket is ${inr(lo)} (over ${inr(b)}).`;
    notes.push(`tickets from ${inr(lo)} fit your ${inr(b)} budget`);
  }
  return notes.length ? `Looks like a fit — ${notes.join(", ")}.` : "";
}

/* -------------------------------- AI reply --------------------------------- */

/** The /api/ai-read reply: "SUMMARY: …", "FIT: …", "VERDICT: …" lines. */
export function parseAiRead(text: string): { summary?: string; fit?: string; verdict?: string } {
  const out: { summary?: string; fit?: string; verdict?: string } = {};
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*\**\s*(SUMMARY|FIT|VERDICT)\s*\**\s*[:：]\s*(.+)$/i.exec(raw);
    if (!m) continue;
    const key = m[1].toLowerCase() as "summary" | "fit" | "verdict";
    const val = m[2].replace(/\*\*/g, "").trim().slice(0, 320);
    // reviews are never invented: drop a line that claims what reviewers say
    if (/\breview(s|ers)?\b(?!.*\bno\b)/i.test(val) && !/no (written )?reviews/i.test(val)) continue;
    if (val && !out[key]) out[key] = val;
  }
  return out;
}
