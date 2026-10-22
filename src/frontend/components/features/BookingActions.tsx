'use client';

// Action row + countdown chip for a Dineout table / Scenes ticket booking:
//   📅 Add to calendar (.ics; Google Calendar link as an alternative)
//   🧭 Directions (Swiggy's map link → venue coordinates → venue name search)
//   ↗ Share (Web Share sheet → clipboard) + WhatsApp
//   ⏱ "Starts in 2h 15m" chip (ticks every 30 s)
// Every fact comes from Swiggy's booking / the slot or show the user picked.

import { useState } from 'react';
import { downloadIcs, googleCalendarUrl, type CalendarEventInput } from '@/frontend/utils/ics';
import { directionsUrl } from '@/frontend/utils/maps';
import { countdownTone, formatCountdown, formatIst } from '@/frontend/utils/time';
import { useNow } from '@/frontend/utils/useLivePoll';
import { shareOrCopy, whatsappUrl } from '@/frontend/utils/webShare';

export interface BookingFacts {
  kind: 'dineout' | 'scenes';
  orderId: string;
  title: string;
  status: string;
  details?: string;
  startsAt?: number;
  endsAt?: number;
  place?: string;
  address?: string;
  lat?: number;
  lng?: number;
  mapUrl?: string;
  guests?: number;
}

const TONE: Record<ReturnType<typeof countdownTone>, string> = {
  soon: 'bg-coral text-on-primary',
  today: 'bg-coral/10 text-coral',
  later: 'bg-surface-card text-body',
  past: 'bg-surface-card text-muted',
};

/** "⏱ Starts in 2h 15m" — hidden when the booking is long over or cancelled. */
export function CountdownChip({ startsAt, endsAt, className = '' }: { startsAt: number; endsAt?: number; className?: string }) {
  const now = useNow(30_000);
  const text = formatCountdown(startsAt, now, endsAt);
  if (!text) return null;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${TONE[countdownTone(startsAt, now)]} ${className}`}
      title={formatIst(startsAt)}
    >
      <span aria-hidden>⏱</span>
      {text}
    </span>
  );
}

function calendarEvent(b: BookingFacts): CalendarEventInput | null {
  if (!b.startsAt) return null;
  const where = [b.place, b.address].filter(Boolean).join(', ');
  return {
    uid: `${b.kind}-${b.orderId}`,
    title: b.title,
    start: b.startsAt,
    end: b.endsAt,
    durationMin: b.kind === 'dineout' ? 120 : 90,
    location: where || undefined,
    description: [
      b.kind === 'dineout' ? 'Swiggy Dineout table booking' : 'Swiggy Scenes tickets',
      b.details,
      `Order #${b.orderId}`,
      b.guests ? `${b.guests} ${b.kind === 'dineout' ? 'guest' : 'ticket'}${b.guests === 1 ? '' : 's'}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    alarmMinutesBefore: b.kind === 'dineout' ? 60 : 90,
  };
}

export function shareText(b: BookingFacts): string {
  return [
    b.kind === 'dineout' ? `🍽️ ${b.title}` : `🎟️ ${b.title}`,
    b.startsAt ? formatIst(b.startsAt) : '',
    b.details,
    [b.place, b.address].filter(Boolean).join(', '),
    `Booked on Swiggy ${b.kind === 'dineout' ? 'Dineout' : 'Scenes'} · #${b.orderId}`,
  ]
    .filter(Boolean)
    .filter((l, i, a) => a.indexOf(l) === i)
    .join('\n');
}

const BTN =
  'inline-flex items-center gap-1 rounded-full border border-hairline bg-canvas px-2.5 py-1 text-[11px] font-semibold text-body transition-colors hover:border-coral/40 hover:text-ink disabled:opacity-50';

export function BookingActions({ booking, cancelled }: { booking: BookingFacts; cancelled?: boolean }) {
  const [note, setNote] = useState('');
  const [calOpen, setCalOpen] = useState(false);
  const ev = cancelled ? null : calendarEvent(booking);
  const maps = directionsUrl({ mapUrl: booking.mapUrl, lat: booking.lat, lng: booking.lng, name: booking.place, address: booking.address });
  const text = shareText(booking);
  const flash = (t: string) => {
    setNote(t);
    window.setTimeout(() => setNote(''), 2500);
  };

  return (
    <div className="mt-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {ev && (
          <span className="relative">
            <button type="button" className={BTN} onClick={() => setCalOpen((v) => !v)} aria-expanded={calOpen}>
              <span aria-hidden>📅</span> Add to calendar
            </button>
            {calOpen && (
              <span className="absolute left-0 top-full z-20 mt-1 flex w-48 flex-col overflow-hidden rounded-xl border border-hairline bg-canvas text-xs shadow-card">
                <button
                  type="button"
                  className="px-3 py-2 text-left text-body hover:bg-surface-card hover:text-ink"
                  onClick={() => {
                    downloadIcs(ev);
                    setCalOpen(false);
                    flash('Calendar file downloaded');
                  }}
                >
                  Apple / Outlook (.ics)
                </button>
                <a
                  href={googleCalendarUrl(ev)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-3 py-2 text-body hover:bg-surface-card hover:text-ink"
                  onClick={() => setCalOpen(false)}
                >
                  Google Calendar ↗
                </a>
              </span>
            )}
          </span>
        )}
        {maps && (
          <a href={maps} target="_blank" rel="noopener noreferrer" className={BTN}>
            <span aria-hidden>🧭</span> Directions
          </a>
        )}
        <button
          type="button"
          className={BTN}
          onClick={async () => {
            const r = await shareOrCopy({ title: booking.title, text });
            if (r === 'copied') flash('Booking details copied');
            else if (r === 'failed') flash('Could not share on this device');
          }}
        >
          <span aria-hidden>↗</span> Share
        </button>
        <a href={whatsappUrl(text)} target="_blank" rel="noopener noreferrer" className={BTN} aria-label="Share on WhatsApp">
          <span aria-hidden>💬</span> WhatsApp
        </a>
      </div>
      {note && (
        <p className="mt-1 text-[11px] text-emerald-700 dark:text-emerald-400" role="status">
          {note}
        </p>
      )}
    </div>
  );
}

export default BookingActions;
