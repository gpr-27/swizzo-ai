// Time helpers for live cards: countdown chips ("Starts in 2h 15m"),
// "Updated 12s ago" stamps, and a lenient parser that recovers a booking's
// start time from Swiggy's display strings (get_booking_status /
// get_event_booking_status give "2026-10-23" + "7:30 PM", "Fri, 23 Oct" +
// "10:00 pm" …). All IST (Swiggy is India-only). Pure functions.

const IST_OFFSET_MS = 330 * 60_000;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "Starts in 2h 15m" / "Starts in 3 days" / "Starting now" / "Started 20m ago" / "" (long past). */
export function formatCountdown(startMs: number, nowMs: number = Date.now(), endMs?: number): string {
  const diff = startMs - nowMs;
  if (diff <= 0) {
    const end = endMs ?? startMs + 2 * 60 * 60_000;
    if (nowMs < end) return diff > -5 * 60_000 ? 'Starting now' : `Started ${dur(-diff)} ago`;
    return '';
  }
  if (diff < 60_000) return 'Starts in under a minute';
  return `Starts in ${dur(diff)}`;
}

/** 2h 15m · 45m · 3 days · 1 day 4h */
function dur(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${Math.max(1, mins)}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    const m = mins % 60;
    return m ? `${hours}h ${m}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const h = hours % 24;
  if (days >= 3 || !h) return `${days} day${days === 1 ? '' : 's'}`;
  return `${days} day${days === 1 ? '' : 's'} ${h}h`;
}

/** Urgency for styling the countdown chip. */
export function countdownTone(startMs: number, nowMs: number = Date.now()): 'soon' | 'today' | 'later' | 'past' {
  const diff = startMs - nowMs;
  if (diff <= 0) return 'past';
  if (diff <= 2 * 60 * 60_000) return 'soon';
  if (diff <= 24 * 60 * 60_000) return 'today';
  return 'later';
}

/** "just now" · "12s ago" · "3m ago" */
export function formatAgo(thenMs: number, nowMs: number = Date.now()): string {
  const s = Math.max(0, Math.round((nowMs - thenMs) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

/** Epoch ms for an IST wall-clock time. */
export function istToEpoch(y: number, month1: number, d: number, h = 0, min = 0): number {
  return Date.UTC(y, month1 - 1, d, h, min) - IST_OFFSET_MS;
}

/** Today's IST calendar date. */
function istToday(nowMs: number): { y: number; m: number; d: number } {
  const t = new Date(nowMs + IST_OFFSET_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** "7:30 PM" · "10:00 pm" · "19:30" · "7 PM" → [h, m] (24h), or null. */
export function parseClock(text: string): [number, number] | null {
  const m = /\b(\d{1,2})(?:[:.](\d{2}))?\s*([ap])\.?\s*m\b/i.exec(text);
  if (m) {
    let h = Number(m[1]) % 12;
    if (m[3].toLowerCase() === 'p') h += 12;
    const mm = Number(m[2] ?? 0);
    return h < 24 && mm < 60 ? [h, mm] : null;
  }
  const h24 = /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(text);
  return h24 ? [Number(h24[1]), Number(h24[2])] : null;
}

/**
 * The calendar date in `text`: "2026-10-23", "23/10/2026", "23 Oct 2026",
 * "23rd Oct", "Fri, 23 Oct", "Oct 23, 2026", "Today", "Tomorrow". A year-less
 * date takes the next occurrence on/after today (IST).
 */
export function parseDate(text: string, nowMs: number = Date.now()): { y: number; m: number; d: number } | null {
  const t = text.toLowerCase();
  const today = istToday(nowMs);
  if (/\btoday\b/.test(t)) return today;
  if (/\btomorrow\b/.test(t)) {
    const n = new Date(Date.UTC(today.y, today.m - 1, today.d + 1));
    return { y: n.getUTCFullYear(), m: n.getUTCMonth() + 1, d: n.getUTCDate() };
  }
  let m = /\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/.exec(t);
  if (m) return valid(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /\b(\d{1,2})[/.-](\d{1,2})[/.-](20\d{2})\b/.exec(t);
  if (m) return valid(Number(m[3]), Number(m[2]), Number(m[1]));
  const mon = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*';
  m = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${mon}\\.?(?:,?\\s+(20\\d{2}))?`).exec(t);
  let day: number | undefined;
  let month: number | undefined;
  let year: number | undefined;
  if (m) {
    day = Number(m[1]);
    month = MONTHS.indexOf(m[2]) + 1;
    year = m[3] ? Number(m[3]) : undefined;
  } else {
    m = new RegExp(`\\b${mon}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d{2}))?`).exec(t);
    if (!m) return null;
    month = MONTHS.indexOf(m[1]) + 1;
    day = Number(m[2]);
    year = m[3] ? Number(m[3]) : undefined;
  }
  if (year) return valid(year, month, day);
  // No year: this year, or next year when that date has already passed.
  const thisYear = valid(today.y, month, day);
  if (!thisYear) return null;
  const past = Date.UTC(thisYear.y, thisYear.m - 1, thisYear.d) < Date.UTC(today.y, today.m - 1, today.d);
  return past ? valid(today.y + 1, month, day) : thisYear;
}

function valid(y: number, m: number, d: number): { y: number; m: number; d: number } | null {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 ? { y, m, d } : null;
}

/** A booking's start (epoch ms) from Swiggy's display text, or undefined when the text has no date + time. */
export function parseBookingWhen(text: string | undefined, nowMs: number = Date.now()): number | undefined {
  if (!text) return undefined;
  const date = parseDate(text, nowMs);
  const clock = parseClock(text);
  if (!date || !clock) return undefined;
  return istToEpoch(date.y, date.m, date.d, clock[0], clock[1]);
}

/** "Fri, 23 Oct · 10:00 pm" (IST) for an epoch ms. */
export function formatIst(ms: number): string {
  const d = new Date(ms);
  const day = d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
  const time = d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
  return `${day} · ${time}`;
}
