// Chat ↔ open-picker bridge: the pure, framework-free half (used by the server
// prompt / marker parser, the client pickers and scripts/verify-picker.ts).
//
//  - buildScenesActivePicker / buildDineoutActivePicker: the compact snapshot of
//    an OPEN picker's live listing + current selection, sent with a chat turn.
//  - sanitizeActivePicker: route-side validation + size cap of that snapshot.
//  - parsePickBody / extractPickMarkers: the agent's `PICK: date=… | time=…` lines.
//  - resolveScenesPick / resolveDineoutPick: apply a pick to the picker's OWN
//    live data (exact date, time by label/showId, ticket by id or name, clamped
//    counts) — anything that doesn't exist becomes a note, never a guess.
//  - pickFromUserText: the deterministic client-side fallback when the LLM
//    produced no PICK line.
// Everything here only SELECTS inside a picker; nothing creates carts or books.

import type {
  ActivePicker,
  AiPick,
  DineoutActivePicker,
  DineoutSlot,
  PickerSelectFields,
  ScenesActivePicker,
  ScenesShow,
  ScenesShowListing,
} from "./types";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const NUM_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};
const NUM_RE = `(\\d{1,2}|${Object.keys(NUM_WORDS).join("|")})`;
const MAX_COUNT = 20;

function toNum(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const t = v.trim().toLowerCase();
  if (/^\d+$/.test(t)) return Number(t);
  return NUM_WORDS[t];
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Today's calendar date in IST ("YYYY-MM-DD"). */
export function istToday(nowMs = Date.now()): string {
  return new Date(nowMs).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function addDays(key: string, n: number): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function weekdayOf(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** "2026-10-25" → "Sun, 25 Oct" (deterministic, same on server and client). */
export function dayLabel(key: string): string {
  if (!ISO.test(key)) return key;
  const [, m, d] = key.split("-").map(Number);
  return `${WEEKDAY_NAMES[weekdayOf(key)]}, ${d} ${MONTH_NAMES[m - 1]}`;
}

/** Minutes after midnight from "9 pm", "9:30 PM", "21:00", "Sat, 24 Oct, 2:00 pm". */
export function parseClock(s: string): number | null {
  const t = s.toLowerCase();
  if (/\bnoon\b/.test(t)) return 12 * 60;
  if (/\bmidnight\b/.test(t)) return 0;
  const ampm = [...t.matchAll(/(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?\s?m\.?|p\.?\s?m\.?)(?![a-z])/g)].pop();
  if (ampm) {
    let h = Number(ampm[1]);
    const min = Number(ampm[2] ?? 0);
    if (h < 1 || h > 12 || min > 59) return null;
    const pm = ampm[3].startsWith("p");
    if (h === 12) h = 0;
    return (pm ? h + 12 : h) * 60 + min;
  }
  const h24 = t.match(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/);
  if (h24) return Number(h24[1]) * 60 + Number(h24[2]);
  return null;
}

/** "9:00 pm" from minutes after midnight. */
function clockLabel(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

/** "Fri, 23 Oct, 10:00 pm" → "10:00 pm" (Swiggy's display text kept). */
export function showTimeLabel(show: Pick<ScenesShow, "showTimeIst">): string {
  const ist = show.showTimeIst || "";
  const i = ist.lastIndexOf(",");
  return (i > 0 ? ist.slice(i + 1) : ist).trim();
}

/** The date group a show belongs to (same key the ticket picker groups by). */
export function scenesDateKey(show: Pick<ScenesShow, "date" | "showTimeIst">): string {
  if (show.date) return show.date;
  const ist = show.showTimeIst || "";
  const i = ist.lastIndexOf(",");
  return (i > 0 ? ist.slice(0, i).trim() : "") || "shows";
}

/* ------------------------------- text → date ------------------------------- */

interface DateHit {
  key?: string; // a key from the offered dates
  wanted?: string; // what the user asked for, for a "not offered" note
  span?: [number, number]; // where in the text it was found
}

function pickYear(month: number, day: number, keys: string[], nowMs: number): string {
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  const fromKeys = keys.find((k) => k.slice(5) === `${mm}-${dd}`);
  if (fromKeys) return fromKeys;
  const today = istToday(nowMs);
  let y = Number(today.slice(0, 4));
  if (`${y}-${mm}-${dd}` < today) y += 1;
  return `${y}-${mm}-${dd}`;
}

/** Find the first date the text refers to, resolved against the offered `keys`. */
export function findDateIn(text: string, keys: string[], nowMs = Date.now()): DateHit | null {
  const t = text.toLowerCase();
  const offered = (k: string): DateHit => (keys.includes(k) ? { key: k } : { wanted: dayLabel(k) });
  const mon =
    "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
  const tries: [RegExp, (m: RegExpMatchArray) => string | null][] = [
    [/\b(20\d\d)-(\d{2})-(\d{2})\b/, (m) => `${m[1]}-${m[2]}-${m[3]}`],
    [
      new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:of\\s+)?${mon}(?![a-z])`),
      (m) => pickYear(MONTHS.indexOf(m[2].slice(0, 3)) + 1, Number(m[1]), keys, nowMs),
    ],
    [
      new RegExp(`\\b${mon}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`),
      (m) => pickYear(MONTHS.indexOf(m[1].slice(0, 3)) + 1, Number(m[2]), keys, nowMs),
    ],
    [/\b(\d{1,2})\/(\d{1,2})\b/, (m) => pickYear(Number(m[2]), Number(m[1]), keys, nowMs)],
    [/\bday after tomorrow\b/, () => addDays(istToday(nowMs), 2)],
    [/\b(?:today|tonight|this evening)\b/, () => istToday(nowMs)],
    [/\btomorrow\b/, () => addDays(istToday(nowMs), 1)],
  ];
  for (const [re, toKey] of tries) {
    const m = t.match(re);
    if (!m || m.index === undefined) continue;
    const key = toKey(m);
    if (!key || !ISO.test(key)) continue;
    const [, mm, dd] = key.split("-").map(Number);
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) continue;
    return { ...offered(key), span: [m.index, m.index + m[0].length] };
  }
  // "the 25th" — day of month only, matched against the offered dates.
  const ord = t.match(/\b(\d{1,2})(st|nd|rd|th)\b/);
  if (ord && ord.index !== undefined) {
    const day = Number(ord[1]);
    const key = keys.find((k) => Number(k.slice(8)) === day);
    return { ...(key ? { key } : { wanted: `the ${ord[1]}${ord[2]}` }), span: [ord.index, ord.index + ord[0].length] };
  }
  // A weekday: the first offered date that falls on it.
  const wd = t.match(/\b(sun|mon|tue|wed|thu|fri|sat)(?:day|s|nesday|sday|rsday|urday)?\b/);
  if (wd && wd.index !== undefined) {
    const idx = WEEKDAYS.findIndex((w) => w.startsWith(wd[1]));
    const key = [...keys].sort().find((k) => k >= istToday(nowMs) && weekdayOf(k) === idx) ?? keys.find((k) => weekdayOf(k) === idx);
    return { ...(key ? { key } : { wanted: WEEKDAYS[idx][0].toUpperCase() + WEEKDAYS[idx].slice(1) }), span: [wd.index, wd.index + wd[0].length] };
  }
  return null;
}

/* ------------------------------ name matching ------------------------------ */

/** Lower-case, numbers as digits, plurals folded: "Entry Pass For Two" → "entry pass for 2". */
export function normName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9₹ ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (NUM_WORDS[w] !== undefined ? String(NUM_WORDS[w]) : w))
    .map((w) => (w === "passes" ? "pass" : w === "tickets" ? "ticket" : w === "entries" ? "entry" : w))
    .join(" ");
}

/** Resolve a ticket by id, exact name, then a unique containment / token match. */
export function matchTicket<T extends { ticketId: string; title: string }>(value: string, tickets: T[]): T | undefined {
  const v = value.trim();
  if (!v) return undefined;
  const byId = tickets.find((t) => t.ticketId === v);
  if (byId) return byId;
  const n = normName(v);
  const exact = tickets.filter((t) => normName(t.title) === n);
  if (exact.length) return exact[0];
  const contains = tickets.filter((t) => {
    const tn = normName(t.title);
    return tn && (tn.includes(n) || n.includes(tn));
  });
  if (contains.length === 1) return contains[0];
  // Token overlap; numbers must agree ("pass for 2" never matches "pass for 1").
  const words = new Set(n.split(" "));
  const nums = [...words].filter((w) => /^\d+$/.test(w));
  let best: T | undefined;
  let bestScore = 0;
  let tie = false;
  for (const t of tickets) {
    const tw = normName(t.title).split(" ");
    const tnums = tw.filter((w) => /^\d+$/.test(w));
    if (nums.length && tnums.length && !nums.some((x) => tnums.includes(x))) continue;
    const score = tw.filter((w) => words.has(w) && w !== "for").length;
    if (score > bestScore) {
      best = t;
      bestScore = score;
      tie = false;
    } else if (score === bestScore && score > 0) tie = true;
  }
  return bestScore >= 2 && !tie ? best : undefined;
}

/** The longest ticket name that appears in the (normalised) text. */
function ticketInText(text: string, names: string[]): { name: string; span: [number, number] } | null {
  const nt = ` ${normName(text)} `;
  let hit: string | null = null;
  for (const name of names) {
    const nn = normName(name);
    if (nn && nt.includes(` ${nn} `) && (!hit || nn.length > normName(hit).length)) hit = name;
  }
  if (!hit) return null;
  // Remove the words of the name from the raw text so "for two" isn't re-read as a count.
  const words = hit.toLowerCase().split(/\s+/).filter(Boolean);
  const re = new RegExp(
    words
      .map((w) => {
        const n = NUM_WORDS[w] ?? (/^\d+$/.test(w) ? Number(w) : undefined);
        const alt = n !== undefined ? `(?:${n}|${Object.keys(NUM_WORDS).find((k) => NUM_WORDS[k] === n) ?? n})` : w.replace(/[^a-z0-9]/g, "");
        return `${alt}(?:e?s)?`;
      })
      .join("[^a-z0-9]+"),
    "i",
  );
  const m = text.match(re);
  return { name: hit, span: m && m.index !== undefined ? [m.index, m.index + m[0].length] : [0, 0] };
}

function blank(text: string, span?: [number, number]): string {
  if (!span || span[1] <= span[0]) return text;
  return text.slice(0, span[0]) + " ".repeat(span[1] - span[0]) + text.slice(span[1]);
}

/** Party / ticket count in free text (after dates, times and ticket names were removed). */
function countIn(text: string): { tickets?: number; people?: number } {
  const t = text.toLowerCase();
  const tk = t.match(new RegExp(`\\b${NUM_RE}\\s*(?:x\\s*)?(?:tickets?|passe?s?|seats?|entries)\\b`)) ?? t.match(/\bx\s*(\d{1,2})\b/);
  const ppl =
    t.match(new RegExp(`\\b${NUM_RE}\\s*(?:people|persons?|guests?|pax|adults?|of us|members)\\b`)) ??
    t.match(new RegExp(`\\b(?:for|party of|table for|group of)\\s+${NUM_RE}\\b(?!\\s*(?:am|pm|:|\\.\\d))`));
  return { tickets: toNum(tk?.[1]), people: toNum(ppl?.[1]) };
}

/* --------------------------- snapshots (client) ---------------------------- */

const MAX_DATES = 14;
const MAX_SHOWS_PER_DATE = 8;
const MAX_TICKETS = 12;
const MAX_TIMES_PER_MEAL = 24;
const MAX_DEALS = 6;

/** Compact snapshot of an open Scenes ticket picker (real listing data only). */
export function buildScenesActivePicker(
  messageId: string,
  listing: ScenesShowListing,
  sel: { date?: string; showId?: string; ticketId?: string; qty?: number },
): ScenesActivePicker {
  const groups = new Map<string, ScenesShow[]>();
  for (const s of listing.shows) {
    const k = scenesDateKey(s);
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  const dates = [...groups.entries()].slice(0, MAX_DATES).map(([date, shows]) => ({
    date,
    label: ISO.test(date) ? dayLabel(date) : date,
    shows: shows.slice(0, MAX_SHOWS_PER_DATE).map((s) => ({
      showId: s.showId,
      timeLabel: showTimeLabel(s),
      ...(s.availableSeats !== undefined ? { seatsLeft: s.availableSeats } : {}),
      ...(s.onSale ? {} : { soldOut: true }),
    })),
  }));
  // Ticket tiers unioned by name; `onlyOn` when a tier isn't sold on every date.
  const tiers = new Map<string, { name: string; price?: number; dates: Set<string> }>();
  for (const s of listing.shows) {
    for (const t of s.tickets) {
      const k = normName(t.title);
      const cur = tiers.get(k) ?? { name: t.title, price: t.price, dates: new Set<string>() };
      if (t.onSale) cur.dates.add(scenesDateKey(s));
      tiers.set(k, cur);
    }
  }
  const allDates = dates.map((d) => d.date);
  const tickets = [...tiers.values()].slice(0, MAX_TICKETS).map((t) => ({
    name: t.name,
    ...(t.price !== undefined ? { price: t.price } : {}),
    ...(t.dates.size < allDates.length ? { onlyOn: allDates.filter((d) => t.dates.has(d)) } : {}),
  }));
  const show = sel.showId ? listing.shows.find((s) => s.showId === sel.showId) : undefined;
  const ticket = show?.tickets.find((t) => t.ticketId === sel.ticketId);
  return {
    kind: "scenes",
    messageId,
    eventId: listing.eventId,
    eventTitle: listing.eventTitle,
    ...(listing.venueName ? { venueName: listing.venueName } : {}),
    dates,
    tickets,
    selection: {
      ...(sel.date ? { date: sel.date } : {}),
      ...(show ? { showId: show.showId, timeLabel: showTimeLabel(show) } : {}),
      ...(ticket ? { ticketName: ticket.title } : {}),
      ...(sel.qty ? { qty: sel.qty } : {}),
    },
    aiPicks: rankScenesPicks(listing).map(({ id, label, title }) => ({ id, label, title })),
  };
}

function slotOpen(s: DineoutSlot): boolean {
  return s.availableInventory !== 0 && s.deals.some((d) => !d.soldOut);
}

/** Compact snapshot of an open Dineout slot picker (real slots only). */
export function buildDineoutActivePicker(
  messageId: string,
  view: { restaurantId: string; restaurantName: string },
  slots: DineoutSlot[],
  sel: { date?: string; key?: string; itemId?: string; guests: number },
): DineoutActivePicker {
  const order: string[] = [];
  for (const s of slots) if (s.dateStr && !order.includes(s.dateStr)) order.push(s.dateStr);
  const dates = order.slice(0, MAX_DATES).map((date) => {
    const day = slots.filter((s) => s.dateStr === date);
    const meals: Record<string, string[]> = {};
    for (const s of day) {
      if (!slotOpen(s)) continue;
      const g = s.slotGroupName || "Slots";
      const list = (meals[g] ??= []);
      if (list.length < MAX_TIMES_PER_MEAL && !list.includes(s.displayTime)) list.push(s.displayTime);
    }
    const deals = new Map<string, { title: string; free: boolean; price?: number; discount?: number }>();
    for (const s of day) {
      for (const d of s.deals) {
        if (d.soldOut) continue;
        const title = d.title || (d.isFree ? "Table reservation" : "Prebook deal");
        if (deals.size < MAX_DEALS && !deals.has(title)) {
          deals.set(title, {
            title,
            free: d.isFree,
            ...(d.bookingPrice ? { price: d.bookingPrice } : {}),
            ...(d.discountPercentage ? { discount: d.discountPercentage } : {}),
          });
        }
      }
    }
    return { date, label: dayLabel(date), meals, deals: [...deals.values()] };
  });
  const slot = sel.key ? slots.find((s) => s.key === sel.key) : undefined;
  const deal = slot?.deals.find((d) => d.itemId === sel.itemId);
  return {
    kind: "dineout",
    messageId,
    restaurantId: view.restaurantId,
    restaurantName: view.restaurantName,
    dates,
    guests: sel.guests,
    selection: {
      ...(sel.date ? { date: sel.date } : {}),
      ...(slot ? { time: slot.displayTime } : {}),
      ...(deal ? { deal: deal.title || (deal.isFree ? "Table reservation" : "Prebook deal") } : {}),
      guests: sel.guests,
    },
    aiPicks: rankDineoutPicks(slots, { guests: sel.guests }).map(({ id, label, title }) => ({ id, label, title })),
  };
}

/* ------------------------- route-side validation --------------------------- */

const MAX_PICKER_JSON = 14_000;
const str = (v: unknown, max = 120): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const arr = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Rebuild a client-sent activePicker from known fields only; undefined if invalid / too big. */
export function sanitizeActivePicker(raw: unknown): ActivePicker | undefined {
  const r = rec(raw);
  const messageId = str(r.messageId, 100);
  if (!messageId) return undefined;
  let out: ActivePicker | undefined;
  if (r.kind === "scenes") {
    const eventId = str(r.eventId, 40);
    if (!eventId) return undefined;
    const sel = rec(r.selection);
    out = {
      kind: "scenes",
      messageId,
      eventId,
      eventTitle: str(r.eventTitle, 160) ?? "Event",
      venueName: str(r.venueName, 160),
      dates: arr(r.dates, MAX_DATES).map((d) => {
        const dd = rec(d);
        return {
          date: str(dd.date, 20) ?? "",
          label: str(dd.label, 40) ?? "",
          shows: arr(dd.shows, MAX_SHOWS_PER_DATE).map((s) => {
            const ss = rec(s);
            return {
              showId: str(ss.showId, 40) ?? "",
              timeLabel: str(ss.timeLabel, 40) ?? "",
              seatsLeft: num(ss.seatsLeft),
              soldOut: ss.soldOut === true ? true : undefined,
            };
          }).filter((s) => s.showId),
        };
      }).filter((d) => d.date),
      tickets: arr(r.tickets, MAX_TICKETS).map((t) => {
        const tt = rec(t);
        const onlyOn = arr(tt.onlyOn, MAX_DATES).map((x) => str(x, 20)).filter((x): x is string => !!x);
        return { name: str(tt.name, 120) ?? "", price: num(tt.price), onlyOn: onlyOn.length ? onlyOn : undefined };
      }).filter((t) => t.name),
      selection: {
        date: str(sel.date, 20),
        showId: str(sel.showId, 40),
        timeLabel: str(sel.timeLabel, 40),
        ticketName: str(sel.ticketName, 120),
        qty: num(sel.qty),
      },
    };
  } else if (r.kind === "dineout") {
    const restaurantId = str(r.restaurantId, 40);
    if (!restaurantId) return undefined;
    const sel = rec(r.selection);
    out = {
      kind: "dineout",
      messageId,
      restaurantId,
      restaurantName: str(r.restaurantName, 160) ?? "Restaurant",
      dates: arr(r.dates, MAX_DATES).map((d) => {
        const dd = rec(d);
        const meals: Record<string, string[]> = {};
        for (const [k, v] of Object.entries(rec(dd.meals)).slice(0, 6)) {
          const times = arr(v, MAX_TIMES_PER_MEAL).map((x) => str(x, 20)).filter((x): x is string => !!x);
          if (times.length) meals[k.slice(0, 30)] = times;
        }
        return {
          date: str(dd.date, 20) ?? "",
          label: str(dd.label, 40) ?? "",
          meals,
          deals: arr(dd.deals, MAX_DEALS).map((x) => {
            const xx = rec(x);
            return { title: str(xx.title, 120) ?? "", free: xx.free === true, price: num(xx.price), discount: num(xx.discount) };
          }).filter((x) => x.title),
        };
      }).filter((d) => d.date),
      guests: Math.min(MAX_COUNT, Math.max(1, num(r.guests) ?? 2)),
      selection: {
        date: str(sel.date, 20),
        time: str(sel.time, 20),
        deal: str(sel.deal, 120),
        guests: num(sel.guests),
      },
    };
  }
  if (out) {
    const picks = arr(r.aiPicks, 4)
      .map((x) => {
        const xx = rec(x);
        return { id: str(xx.id, 20) ?? "", label: str(xx.label, 30) ?? "", title: str(xx.title, 120) ?? "" };
      })
      .filter((x) => /^[a-z]+$/.test(x.id) && x.title);
    if (picks.length) out.aiPicks = picks;
  }
  if (!out || JSON.stringify(out).length > MAX_PICKER_JSON) return undefined;
  return out;
}

/** The open picker as prompt lines (data only; the rules live in services.ts). */
export function describeActivePicker(ap: ActivePicker): string {
  if (ap.kind === "scenes") {
    const dates = ap.dates
      .map(
        (d) =>
          `  ${d.date} (${d.label}): ${d.shows
            .map((s) => `${s.timeLabel} [showId ${s.showId}${s.soldOut ? ", SOLD OUT" : s.seatsLeft !== undefined ? `, ${s.seatsLeft} seats` : ""}]`)
            .join(" · ")}`,
      )
      .join("\n");
    const tickets = ap.tickets
      .map((t) => `${t.name}${t.price !== undefined ? ` ₹${t.price}` : ""}${t.onlyOn ? ` (only on ${t.onlyOn.join(", ")})` : ""}`)
      .join(" | ");
    const s = ap.selection ?? {};
    const cur = [s.date, s.timeLabel, s.ticketName, s.qty ? `qty ${s.qty}` : ""].filter(Boolean).join(" · ") || "nothing yet";
    return `TICKET PICKER for "${ap.eventTitle}" (eventId ${ap.eventId}${ap.venueName ? `, ${ap.venueName}` : ""}).\nDates & shows:\n${dates}\nTicket types: ${tickets || "none listed"}\nCurrent selection: ${cur}${aiPicksLine(ap)}`;
  }
  const dates = ap.dates
    .map((d) => {
      const meals = Object.entries(d.meals)
        .map(([m, times]) => `${m}: ${times.join(", ")}`)
        .join(" / ");
      const deals = d.deals
        .map((x) => `${x.title} (${x.free ? "free" : `paid${x.price ? ` ₹${x.price}` : ""}`}${x.discount ? `, ${x.discount}% off` : ""})`)
        .join("; ");
      return `  ${d.date} (${d.label}): ${meals || "fully booked"}${deals ? `\n     deals: ${deals}` : ""}`;
    })
    .join("\n");
  const s = ap.selection ?? {};
  const cur = [s.date, s.time, s.deal, `${s.guests ?? ap.guests} guests`].filter(Boolean).join(" · ");
  return `TABLE SLOT PICKER for "${ap.restaurantName}" (restaurantId ${ap.restaurantId}).\nOpen times per date:\n${dates}\nCurrent selection: ${cur}${aiPicksLine(ap)}`;
}

function aiPicksLine(ap: ActivePicker): string {
  return ap.aiPicks?.length
    ? `\nAI PICKS shown in the picker: ${ap.aiPicks.map((p) => `${p.id} = ${p.label}: ${p.title}`).join(" ; ")}`
    : "";
}

/* ------------------------------ PICK markers ------------------------------- */

/** `date=2026-10-25 | time=9:00 pm | ticket=Entry Pass For Two | qty=1` → fields. */
export function parsePickBody(body: string): PickerSelectFields {
  const out: PickerSelectFields = {};
  for (const part of body.split("|")) {
    const m = part.match(/^\s*([a-z_]+)\s*[=:]\s*(.+?)\s*$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].replace(/^["'`]+|["'`]+$/g, "").trim().slice(0, 120);
    if (!value || /^(-|none|null|n\/a|any)$/i.test(value)) continue;
    if (key === "date" || key === "day") out.date = value;
    else if (key === "time" || key === "show") {
      if (/^\d{5,}$/.test(value)) out.showId = value;
      else out.time = value;
    } else if (key === "showid") out.showId = value;
    else if (key === "ticket" || key === "tier" || key === "ticketid" || key === "ticketname") {
      if (/^\d{4,}$/.test(value)) out.ticketId = value;
      else out.ticketName = value;
    } else if (key === "qty" || key === "quantity" || key === "tickets" || key === "count") {
      const n = toNum(value.match(/\d+|[a-z]+/i)?.[0]);
      if (n) out.qty = n;
    } else if (key === "guests" || key === "people" || key === "pax") {
      const n = toNum(value.match(/\d+|[a-z]+/i)?.[0]);
      if (n) out.guests = n;
    } else if (key === "deal") out.deal = value;
    else if (key === "confirm" || key === "book") out.confirm = /^(1|yes|true|y)$/i.test(value);
  }
  if (out.confirm === false) delete out.confirm;
  return out;
}

/** Strip `WHY: <pickId> — reason` lines (the model's words for the AI PICKS). */
export function extractWhyMarkers(text: string): { rest: string; reasons: { id: string; why: string }[] } {
  const reasons: { id: string; why: string }[] = [];
  const rest = text.replace(/^[ \t>*_\-•]*\**_*WHY\**_*\s*:\**_*\s*([a-z]+)\s*[-—:–]\s*([^\n]+)$/gim, (_m, id: string, why: string) => {
    const w = why.trim().replace(/^["']|["']$/g, "").slice(0, 90);
    if (w) reasons.push({ id: id.toLowerCase(), why: w });
    return "";
  });
  return { rest, reasons };
}

/** Strip `PICK:` lines from a reply and return them parsed. */
export function extractPickMarkers(text: string): { rest: string; picks: PickerSelectFields[] } {
  const picks: PickerSelectFields[] = [];
  const rest = text.replace(/^[ \t>*_\-•]*\**_*PICK\**_*\s*:\**_*\s*([^\n]*)$/gim, (_m, body: string) => {
    const p = parsePickBody(body);
    if (Object.keys(p).length) picks.push(p);
    return "";
  });
  return { rest, picks };
}

/* --------------------- apply a pick to live picker data -------------------- */

export interface ScenesPickResult {
  date?: string;
  showId?: string;
  ticketId?: string;
  qty?: number;
  /** the date has several shows and none was named — the user must pick one */
  awaitShow?: boolean;
  /** the ticket the user named, to apply once they pick a show */
  pendingTicket?: string;
  notes: string[];
}

function resolveTimeAmong<T>(value: string, items: T[], id: (t: T) => string, label: (t: T) => string): T | undefined {
  const v = value.trim();
  const byId = items.find((t) => id(t) === v);
  if (byId) return byId;
  const clock = parseClock(v);
  if (clock !== null) return items.find((t) => parseClock(label(t)) === clock);
  const n = v.toLowerCase();
  return items.find((t) => label(t).toLowerCase() === n);
}

/** Resolve a pick against a Scenes listing (the picker's live data). */
export function resolveScenesPick(
  listing: ScenesShowListing,
  pick: PickerSelectFields,
  /** the picker's current date, the show the user explicitly chose, and the defaulted one */
  current: { date?: string; showId?: string; defaultShowId?: string } = {},
  nowMs = Date.now(),
): ScenesPickResult {
  const notes: string[] = [];
  const keys: string[] = [];
  for (const s of listing.shows) {
    const k = scenesDateKey(s);
    if (!keys.includes(k)) keys.push(k);
  }
  const showsOn = (k: string) => listing.shows.filter((s) => scenesDateKey(s) === k);
  const label = (k: string) => (ISO.test(k) ? dayLabel(k) : k);
  const res: ScenesPickResult = { notes };

  let date: string | undefined;
  if (pick.date) {
    const v = pick.date.trim();
    if (keys.includes(v)) date = v;
    else {
      const hit = findDateIn(v, keys, nowMs);
      if (hit?.key) date = hit.key;
      else {
        notes.push(
          `${hit?.wanted ?? v} isn't available for this event — open dates: ${keys.map(label).join(", ")}.`,
        );
        return res;
      }
    }
  }
  const byId = (id?: string) => (id ? listing.shows.find((s) => s.showId === id) : undefined);
  let show: ScenesShow | undefined;
  if (!pick.date && !pick.time && !pick.showId) {
    // Only the ticket / count changed → stay on the current show.
    show = byId(current.showId) ?? byId(current.defaultShowId);
    if (show) date = scenesDateKey(show);
  } else if (!date) {
    // A show named without a date → on the current date first, else the one show across all dates.
    const c = parseClock(pick.time ?? "");
    const matches = (s: ScenesShow) =>
      pick.showId ? s.showId === pick.showId : c !== null && parseClock(showTimeLabel(s)) === c;
    const onCurrent = current.date ? listing.shows.filter((s) => scenesDateKey(s) === current.date && matches(s)) : [];
    const all = listing.shows.filter(matches);
    const hit = onCurrent.length === 1 ? onCurrent[0] : all.length === 1 ? all[0] : undefined;
    if (hit) {
      show = hit;
      date = scenesDateKey(hit);
    } else if (current.date) date = current.date;
  } else if (!pick.time && !pick.showId && date === current.date) {
    // Same date restated → keep a show the user already chose on it.
    const chosen = byId(current.showId);
    if (chosen && scenesDateKey(chosen) === date) show = chosen;
  }
  if (!date && !show) date = current.date && keys.includes(current.date) ? current.date : undefined;
  if (date) res.date = date;

  const dayShows = date ? showsOn(date) : [];
  if (!show && date && (pick.showId || pick.time)) {
    show = resolveTimeAmong(pick.showId || pick.time || "", dayShows, (s) => s.showId, showTimeLabel);
    if (!show) {
      notes.push(
        `There's no ${pick.time ?? "such"} show on ${label(date)} — shows: ${dayShows.map(showTimeLabel).join(", ") || "none"}.`,
      );
    }
  }
  if (!show && date && !pick.showId && !pick.time) {
    const open = dayShows.filter((s) => s.onSale);
    if (dayShows.length === 1) show = dayShows[0];
    else if (open.length === 1 && dayShows.length > 1) show = open[0];
  }
  if (show) {
    res.showId = show.showId;
    if (!show.onSale) notes.push(`The ${showTimeLabel(show)} show on ${label(scenesDateKey(show))} is sold out.`);
  } else if (date && dayShows.length > 1) {
    res.awaitShow = true;
    notes.push(`${label(date)} has ${dayShows.length} shows — pick a time: ${dayShows.map(showTimeLabel).join(", ")}.`);
  }

  const ticketValue = pick.ticketId || pick.ticketName;
  let ticket: ScenesShow["tickets"][number] | undefined;
  if (ticketValue) {
    if (show) {
      ticket = matchTicket(ticketValue, show.tickets);
      if (!ticket) {
        notes.push(
          `"${pick.ticketName ?? ticketValue}" isn't offered for that show — available: ${show.tickets.map((t) => t.title).join(", ") || "none"}.`,
        );
      } else if (!ticket.onSale) {
        notes.push(`${ticket.title} is sold out for that show.`);
        ticket = undefined;
      } else res.ticketId = ticket.ticketId;
    } else if (res.awaitShow) {
      res.pendingTicket = pick.ticketName ?? ticketValue;
    }
  }

  if (pick.qty !== undefined) {
    const min = Math.max(1, show?.minGuests ?? 1);
    const max = Math.max(
      min,
      Math.min(MAX_COUNT, show?.maxGuests ?? MAX_COUNT, ticket?.availableInventory ?? MAX_COUNT, show?.availableSeats ?? MAX_COUNT),
    );
    const q = Math.min(Math.max(Math.round(pick.qty), min), max);
    if (q !== pick.qty) notes.push(q < pick.qty ? `Only ${max} can be booked here — set to ${q}.` : `The minimum is ${min} — set to ${q}.`);
    res.qty = q;
  }
  return res;
}

export interface DineoutPickResult {
  date?: string;
  key?: string;
  itemId?: string;
  guests?: number;
  notes: string[];
}

/** Resolve a pick against a Dineout picker's live slots. */
export function resolveDineoutPick(
  slots: DineoutSlot[],
  pick: PickerSelectFields,
  current: { date?: string } = {},
  nowMs = Date.now(),
): DineoutPickResult {
  const notes: string[] = [];
  const res: DineoutPickResult = { notes };
  const keys: string[] = [];
  for (const s of slots) if (s.dateStr && !keys.includes(s.dateStr)) keys.push(s.dateStr);

  let date: string | undefined;
  if (pick.date) {
    const v = pick.date.trim();
    if (keys.includes(v)) date = v;
    else {
      const hit = findDateIn(v, keys, nowMs);
      if (hit?.key) date = hit.key;
      else {
        notes.push(`${hit?.wanted ?? v} isn't in the open booking window — dates: ${keys.map(dayLabel).join(", ")}.`);
        return res;
      }
    }
  } else if (current.date && keys.includes(current.date)) date = current.date;
  if (pick.date && date) res.date = date;

  if (pick.guests !== undefined) {
    const g = Math.min(MAX_COUNT, Math.max(1, Math.round(pick.guests)));
    if (g !== pick.guests) notes.push(`Tables here are for 1–${MAX_COUNT} guests — set to ${g}.`);
    res.guests = g;
  }

  if (!pick.time) {
    if (pick.deal) notes.push("Pick a time to choose a deal.");
    return res;
  }
  if (!date) {
    notes.push("Pick a date first.");
    return res;
  }
  res.date = date;
  const day = slots.filter((s) => s.dateStr === date);
  const slot = resolveTimeAmong(pick.time, day, (s) => s.key, (s) => s.displayTime);
  if (!slot) {
    const want = parseClock(pick.time);
    const open = day.filter(slotOpen);
    const near =
      want === null
        ? open.slice(0, 3)
        : [...open].sort((a, b) => Math.abs((parseClock(a.displayTime) ?? 0) - want) - Math.abs((parseClock(b.displayTime) ?? 0) - want)).slice(0, 3);
    notes.push(
      `There's no ${want !== null ? clockLabel(want) : pick.time} slot on ${dayLabel(date)}${near.length ? ` — nearest open: ${near.map((s) => s.displayTime).join(", ")}` : ""}.`,
    );
    return res;
  }
  if (!slotOpen(slot)) {
    notes.push(`${slot.displayTime} on ${dayLabel(date)} is fully booked.`);
    return res;
  }
  res.key = slot.key;
  const open = slot.deals.filter((d) => !d.soldOut);
  const want = pick.deal?.trim().toLowerCase();
  let deal = open.find((d) => d.isFree) ?? open[0];
  if (want) {
    const found =
      want === "free"
        ? open.find((d) => d.isFree)
        : want === "paid" || want === "prebook"
          ? open.find((d) => !d.isFree)
          : open.find((d) => d.itemId === pick.deal) ?? open.find((d) => (d.title ?? "").toLowerCase().includes(want));
    if (found) deal = found;
    else
      notes.push(
        `No ${want === "free" ? "free reservation" : want === "paid" ? "paid deal" : `"${pick.deal}" deal`} at ${slot.displayTime} — options: ${open
          .map((d) => d.title || (d.isFree ? "Table reservation" : "Prebook deal"))
          .join(", ")}.`,
      );
  }
  if (deal) res.itemId = deal.itemId;
  return res;
}

/* ------------------- deterministic fallback (no LLM PICK) ------------------- */

/**
 * Read a selection straight out of the user's message for the open picker:
 * "25 October … entry pass for two" → {date, ticketName:"Entry Pass For Two", qty:1}.
 * Returns null when the message names nothing the picker offers.
 */
export function pickFromUserText(text: string, ap: ActivePicker, nowMs = Date.now()): PickerSelectFields | null {
  let rest = text;
  const out: PickerSelectFields = {};
  const keys = ap.dates.map((d) => d.date);
  const dateHit = findDateIn(rest, keys, nowMs);
  if (dateHit?.key) out.date = dateHit.key;
  else if (dateHit?.wanted) out.date = dateHit.wanted; // resolver turns it into a "not offered" note
  rest = blank(rest, dateHit?.span);

  const clock = parseClock(rest);
  if (clock !== null) {
    out.time = clockLabel(clock);
    rest = rest.replace(/(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?\s?m\.?|p\.?\s?m\.?)(?![a-z])|\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/gi, " ");
  }

  if (ap.kind === "scenes") {
    const hit = ticketInText(rest, ap.tickets.map((t) => t.name));
    if (hit) {
      out.ticketName = hit.name;
      rest = blank(rest, hit.span);
    }
    const { tickets, people } = countIn(rest);
    if (tickets) out.qty = tickets;
    else if (people) {
      // "for 4 people" with a "… For 2" pass → 2 passes; a per-person ticket → 4.
      const per = Number(normName(out.ticketName ?? "").match(/\bfor (\d+)$/)?.[1] ?? 1) || 1;
      out.qty = Math.max(1, Math.ceil(people / per));
    } else if (out.ticketName) out.qty = 1;
  } else {
    const { people, tickets } = countIn(rest);
    if (people ?? tickets) out.guests = people ?? tickets;
    const t = rest.toLowerCase();
    if (/\bfree\b/.test(t)) out.deal = "free";
    else if (/\b(paid|pre-?book)\b/.test(t)) out.deal = "paid";
  }
  // A bare count with nothing else isn't a picker instruction.
  const meaningful = out.date || out.time || out.ticketName || out.deal;
  if (meaningful && /\b(book|reserve|confirm|go ahead|get (?:me|us))\b/i.test(text)) out.confirm = true;
  return meaningful ? out : null;
}

/* ------------------ server guard: don't swap pickers silently --------------- */

const TITLE_STOP = new Set([
  "the", "and", "for", "with", "show", "shows", "live", "event", "events", "night", "tickets", "ticket",
  "bangalore", "bengaluru", "mumbai", "delhi", "hyderabad", "chennai", "pune", "restaurant", "cafe", "bar",
]);

function titleWords(s: string): string[] {
  return normName(s)
    .split(" ")
    .filter((w) => w.length >= 3 && !TITLE_STOP.has(w));
}

function overlap(message: string, title: string): number {
  const m = new Set(normName(message).split(" "));
  return titleWords(title).filter((w) => m.has(w)).length;
}

/**
 * While a picker is open, a tool result that would open ANOTHER picker of the
 * same kind (a different event's tickets / restaurant's slots) only renders
 * when the user plainly asked for it: they mention tickets / slots / booking
 * and aren't just refining the open picker ("the 25th, entry pass for two").
 * Returns the blocked title, or null when the card may render.
 */
export function blocksOtherPicker(
  ev: { type: string; eventId?: string; eventTitle?: string; restaurantId?: string; restaurantName?: string },
  ap: ActivePicker | undefined,
  userMessage: string,
  nowMs = Date.now(),
): string | null {
  if (!ap) return null;
  let other: string | null = null;
  let open = "";
  if (ev.type === "scenesShows" && ap.kind === "scenes" && ev.eventId && ev.eventId !== ap.eventId) {
    other = ev.eventTitle || "another event";
    open = ap.eventTitle;
  } else if (ev.type === "dineoutSlots" && ap.kind === "dineout" && ev.restaurantId && ev.restaurantId !== ap.restaurantId) {
    other = ev.restaurantName || "another restaurant";
    open = ap.restaurantName;
  }
  if (!other) return null;
  const asks = /\b(tickets?|show ?times?|shows|slots?|seats?|book|booking|reserve|reservation|table|availability|available|passe?s?)\b/i.test(
    userMessage,
  );
  if (!asks) return other;
  // a swap needs the other one named ("tickets for <title>") or pointed at
  // ("the second one") — and never when the words refine the open picker.
  const namesOther = overlap(userMessage, other) > overlap(userMessage, open);
  if (namesOther) return null;
  const pointsAt = /\b(first|second|third|fourth|last|other one|that one|this one|that event|that place)\b/i.test(userMessage);
  return pointsAt && !pickFromUserText(userMessage, ap, nowMs) ? null : other;
}

/* ------------------------------- AI PICKS ---------------------------------- */

/** "Tonight" / "Today" / "Tomorrow" / "Sat, 24 Oct" for a date key. */
export function relDay(key: string, clockMin: number | null, nowMs = Date.now()): string {
  const today = istToday(nowMs);
  if (key === today) return clockMin !== null && clockMin >= 17 * 60 ? "Tonight" : "Today";
  if (key === addDays(today, 1)) return "Tomorrow";
  return dayLabel(key);
}

const PRIME = 20 * 60; // 8 PM
const isWeekendKey = (k: string) => ISO.test(k) && [5, 6].includes(weekdayOf(k)); // Fri / Sat nights

function slotDiscount(s: DineoutSlot): number {
  const fromDeals = Math.max(0, ...s.deals.filter((d) => !d.soldOut).map((d) => d.discountPercentage ?? 0));
  const fromText = Number(s.subText?.match(/(\d{1,2})\s*%/)?.[1] ?? 0);
  return Math.max(fromDeals, fromText);
}

/**
 * 2–3 concrete Dineout recommendations from the live slots: Soonest, Best value
 * (free table + biggest discount near prime time) and Prime time (≈ 8 PM, a
 * Fri/Sat night when there is one). Only open, future slots; no invented data.
 */
export function rankDineoutPicks(slots: DineoutSlot[], opts: { guests: number; nowMs?: number }): AiPick[] {
  const nowMs = opts.nowMs ?? Date.now();
  const open = slots
    .filter((s) => slotOpen(s) && s.reservationTime * 1000 > nowMs)
    .sort((a, b) => a.reservationTime - b.reservationTime);
  if (!open.length) return [];
  const make = (id: string, label: string, s: DineoutSlot, why: string): AiPick => {
    const deals = s.deals.filter((d) => !d.soldOut);
    const free = deals.find((d) => d.isFree);
    const deal = free ?? deals[0];
    const disc = slotDiscount(s);
    const clock = parseClock(s.displayTime);
    return {
      id,
      label,
      title: [
        `${relDay(s.dateStr, clock, nowMs)} ${s.displayTime}`,
        free ? "free table" : deal?.bookingPrice ? `₹${deal.bookingPrice} deal` : "paid deal",
        disc ? `${disc}% off` : "",
      ]
        .filter(Boolean)
        .join(" · "),
      why,
      sel: {
        date: s.dateStr,
        time: s.displayTime,
        deal: free ? "free" : deal?.itemId,
        guests: opts.guests,
      },
    };
  };
  const picks: AiPick[] = [];
  const used = new Set<string>();
  const add = (p: AiPick | null, key?: string) => {
    if (p && key && !used.has(key)) {
      used.add(key);
      picks.push(p);
    }
  };
  const first = open[0];
  add(make("soonest", "Soonest", first, `The earliest open table${slotDiscount(first) ? `, still ${slotDiscount(first)}% off` : ""}.`), first.key);

  const prox = (s: DineoutSlot) => Math.abs((parseClock(s.displayTime) ?? PRIME) - PRIME);
  const value = [...open].sort((a, b) => {
    const score = (s: DineoutSlot) =>
      (s.deals.some((d) => d.isFree && !d.soldOut) ? 100 : 0) + slotDiscount(s) * 2 - Math.min(prox(s), 240) / 30;
    return score(b) - score(a) || a.reservationTime - b.reservationTime;
  })[0];
  add(
    make(
      "value",
      "Best value",
      value,
      `${value.deals.some((d) => d.isFree && !d.soldOut) ? "No booking fee" : "Prebook deal"}${slotDiscount(value) ? ` and ${slotDiscount(value)}% off the bill` : ""} at a good dinner hour.`,
    ),
    value.key,
  );

  const evening = open.filter((s) => prox(s) <= 60);
  // prefer a different night than the value pick, so the three options really differ
  const otherDay = (x: DineoutSlot) => (x.dateStr === value.dateStr ? 1 : 0);
  const prime =
    [...evening]
      .filter((s) => isWeekendKey(s.dateStr) && !used.has(s.key))
      .sort((a, b) => otherDay(a) - otherDay(b) || prox(a) - prox(b) || a.reservationTime - b.reservationTime)[0] ??
    [...evening].filter((s) => !used.has(s.key)).sort((a, b) => a.dateStr.localeCompare(b.dateStr) || prox(a) - prox(b))[0];
  if (prime) {
    add(make("prime", "Prime time", prime, `Right at dinner peak${isWeekendKey(prime.dateStr) ? " on a weekend night" : ""}.`), prime.key);
  } else {
    const late = open.find((s) => !used.has(s.key) && s.dateStr !== first.dateStr);
    if (late) add(make("later", "Another day", late, "A different day if the first doesn't suit."), late.key);
  }
  return picks.slice(0, 3);
}

/** Price per person: a "… For 2" pass counts for two. */
function perPerson(t: { title: string; price?: number }): number {
  const n = Number(normName(t.title).match(/\bfor (\d+)\b/)?.[1] ?? 1) || 1;
  return (t.price ?? Infinity) / n;
}

/**
 * 2–3 concrete Scenes recommendations: Soonest show, Best value (lowest price
 * per person) and Selling fast (≤ 5 seats) or a Weekend show. On-sale only.
 */
export function rankScenesPicks(listing: ScenesShowListing, opts: { nowMs?: number } = {}): AiPick[] {
  const nowMs = opts.nowMs ?? Date.now();
  const shows = listing.shows
    .filter((s) => s.onSale && (!s.showTimeUnix || s.showTimeUnix * 1000 > nowMs) && s.tickets.some((t) => t.onSale))
    .sort((a, b) => a.showTimeUnix - b.showTimeUnix);
  if (!shows.length) return [];
  const cheapest = (s: ScenesShow) => [...s.tickets.filter((t) => t.onSale)].sort((a, b) => perPerson(a) - perPerson(b))[0];
  const make = (id: string, label: string, s: ScenesShow, t: ScenesShow["tickets"][number], why: string): AiPick => {
    const day = scenesDateKey(s);
    const time = showTimeLabel(s);
    return {
      id,
      label,
      title: [
        `${ISO.test(day) ? relDay(day, parseClock(time), nowMs) : day} ${time}`,
        t.title,
        t.price !== undefined ? (t.price === 0 ? "Free" : `₹${t.price}`) : "",
      ]
        .filter(Boolean)
        .join(" · "),
      why,
      sel: { date: day, showId: s.showId, time, ticketId: t.ticketId, ticketName: t.title, qty: 1 },
    };
  };
  const picks: AiPick[] = [];
  const used = new Set<string>();
  const push = (p: AiPick) => {
    const key = `${p.sel.showId}|${p.sel.ticketId}`;
    if (used.has(key)) return;
    used.add(key);
    used.add(`show:${p.sel.showId}`);
    picks.push(p);
  };
  // Soonest: the next show at its lowest ticket price.
  const s0 = shows[0];
  const low = [...s0.tickets.filter((t) => t.onSale)].sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity))[0];
  push(make("soonest", "Soonest", s0, low, "The next show you can still get into."));

  let best: { s: ScenesShow; t: ScenesShow["tickets"][number] } | null = null;
  for (const s of shows) {
    const t = cheapest(s);
    if (!t) continue;
    if (!best || perPerson(t) < perPerson(best.t) - 0.01) best = { s, t };
  }
  if (best) {
    const pp = perPerson(best.t);
    push(
      make(
        "value",
        "Best value",
        best.s,
        best.t,
        Number.isFinite(pp) ? `Lowest price per person (₹${Math.round(pp)}).` : "The best-priced tier on sale.",
      ),
    );
  }
  const fast = shows.find((s) => !used.has(`show:${s.showId}`) && s.availableSeats !== undefined && s.availableSeats <= 5);
  if (fast) push(make("fast", "Selling fast", fast, cheapest(fast), `Only ${fast.availableSeats} seats left.`));
  else {
    const wk = shows.find((s) => !used.has(`show:${s.showId}`) && [0, 5, 6].includes(weekdayOf(scenesDateKey(s))));
    if (wk) push(make("weekend", "Weekend", wk, cheapest(wk), "A weekend show if you'd rather go then."));
  }
  return picks.slice(0, 3);
}

/**
 * The selection for a one-tap "Book best" from the results: the Best value pick
 * (a FREE table first for Dineout), else the first. A free Dineout table opens
 * its confirm summary (book_table still needs the user's Confirm tap); a paid
 * deal or a Scenes ticket is only selected — no cart is created automatically.
 */
export function oneTapPick(kind: "dineout" | "scenes", picks: AiPick[]): PickerSelectFields | null {
  if (!picks.length) return null;
  if (kind === "dineout") {
    const free = picks.find((p) => p.id === "value" && p.sel.deal === "free") ?? picks.find((p) => p.sel.deal === "free");
    const p = free ?? picks.find((x) => x.id === "value") ?? picks[0];
    return p.sel.deal === "free" ? { ...p.sel, confirm: true } : { ...p.sel };
  }
  const p = picks.find((x) => x.id === "value") ?? picks[0];
  return { ...p.sel };
}

/** Short deterministic read shown while (or if) the AI read isn't available. */
export function quickRead(ap: ActivePicker): string {
  if (ap.kind === "dineout") {
    const parts = ap.dates.slice(0, 3).map((d) => {
      const n = Object.values(d.meals).reduce((a, t) => a + t.length, 0);
      const free = d.deals.some((x) => x.free);
      const disc = Math.max(0, ...d.deals.map((x) => x.discount ?? 0));
      return `${relDay(d.date, null)}: ${n ? `${n} open${free ? " · free tables" : ""}${disc ? ` · up to ${disc}% off` : ""}` : "fully booked"}`;
    });
    return `**${ap.restaurantName}** — ${parts.join(" · ")}.`;
  }
  const shows = ap.dates.reduce((a, d) => a + d.shows.length, 0);
  const from = Math.min(...ap.tickets.map((t) => t.price ?? Infinity));
  return `**${ap.eventTitle}** — ${shows} show${shows === 1 ? "" : "s"} across ${ap.dates.length} date${ap.dates.length === 1 ? "" : "s"}${
    Number.isFinite(from) ? `, tickets from ₹${from}` : ""
  }.`;
}

/** Appended to a slots / shows tool result so the model writes the AI read + WHY lines. */
export function pickerToolNote(
  events: { type: string }[],
  guests = 2,
  nowMs = Date.now(),
): string {
  const lines: string[] = [];
  for (const ev of events) {
    let picks: AiPick[] = [];
    if (ev.type === "dineoutSlots") picks = rankDineoutPicks((ev as unknown as { slots: DineoutSlot[] }).slots, { guests, nowMs });
    else if (ev.type === "scenesShows") picks = rankScenesPicks(ev as unknown as ScenesShowListing, { nowMs });
    else continue;
    if (!picks.length) continue;
    lines.push(
      `AI PICKS shown in the picker (computed from this data): ${picks.map((p) => `${p.id} = ${p.label}: ${p.title}`).join(" ; ")}`,
      "Give a 2-3 line expert read of this REAL availability (what's open when, free vs paid, discounts, seats left) tuned to what the user asked, then one line per pick: WHY: <pick id> — <≤10-word reason>. If the user already said exactly what to book, also emit the PICK line (with confirm=1 if they asked to book). SUGGESTIONS chips must be concrete booking actions from this data (e.g. \"Book tomorrow 8 PM for 2\").",
    );
  }
  return lines.length ? `\n${lines.join("\n")}` : "";
}
