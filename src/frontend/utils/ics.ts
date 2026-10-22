// "Add to calendar" for Dineout bookings and Scenes tickets: a standards-
// compliant iCalendar (RFC 5545) VEVENT built from the booking's real date /
// time / venue, downloaded as an .ics file (opens in Apple / Google / Outlook
// calendars). Pure builder + a tiny browser download helper.

export interface CalendarEventInput {
  uid: string; // stable per booking (orderId) so re-adding updates, not duplicates
  title: string;
  start: number; // epoch ms
  end?: number; // epoch ms (default: start + durationMin)
  durationMin?: number; // used when `end` is missing (default 120)
  location?: string;
  description?: string;
  url?: string;
  alarmMinutesBefore?: number; // a reminder (default 60; 0 = none)
}

/** 20261023T163000Z */
export function icsDate(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** RFC 5545 TEXT escaping: backslash, semicolon, comma, newline. */
export function icsEscape(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Fold lines longer than 75 octets (continuation lines start with a space). */
export function icsFold(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let cur = '';
  let curBytes = 0;
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length;
    const limit = out.length === 0 ? 75 : 74; // continuation lines carry a leading space
    if (curBytes + n > limit) {
      out.push(cur);
      cur = '';
      curBytes = 0;
    }
    cur += ch;
    curBytes += n;
  }
  if (cur) out.push(cur);
  return out.join('\r\n ');
}

export function buildIcs(ev: CalendarEventInput, now: number = Date.now()): string {
  const end = ev.end && ev.end > ev.start ? ev.end : ev.start + (ev.durationMin ?? 120) * 60_000;
  const alarm = ev.alarmMinutesBefore ?? 60;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Swizzo//Swiggy concierge//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${icsEscape(ev.uid)}@swizzo`,
    `DTSTAMP:${icsDate(now)}`,
    `DTSTART:${icsDate(ev.start)}`,
    `DTEND:${icsDate(end)}`,
    `SUMMARY:${icsEscape(ev.title)}`,
    ...(ev.location ? [`LOCATION:${icsEscape(ev.location)}`] : []),
    ...(ev.description ? [`DESCRIPTION:${icsEscape(ev.description)}`] : []),
    ...(ev.url ? [`URL:${ev.url}`] : []),
    ...(alarm > 0
      ? ['BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape(ev.title)}`, `TRIGGER:-PT${Math.round(alarm)}M`, 'END:VALARM']
      : []),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(icsFold).join('\r\n') + '\r\n';
}

/** "Table at Toit" → "table-at-toit.ics" */
export function icsFileName(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'booking'}.ics`;
}

/** Download the event as an .ics file (browser only). */
export function downloadIcs(ev: CalendarEventInput): void {
  if (typeof document === 'undefined') return;
  const blob = new Blob([buildIcs(ev)], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = icsFileName(ev.title);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/** A Google Calendar "add event" link (an alternative to the .ics download). */
export function googleCalendarUrl(ev: CalendarEventInput): string {
  const end = ev.end && ev.end > ev.start ? ev.end : ev.start + (ev.durationMin ?? 120) * 60_000;
  const qs = new URLSearchParams({
    action: 'TEMPLATE',
    text: ev.title,
    dates: `${icsDate(ev.start)}/${icsDate(end)}`,
    ...(ev.location ? { location: ev.location } : {}),
    ...(ev.description ? { details: ev.description } : {}),
  });
  return `https://calendar.google.com/calendar/render?${qs.toString()}`;
}
