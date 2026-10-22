'use client';

// One Scenes event card. Swiggy strips every image/media field from Scenes
// responses, so the card leads with GENERATED poster artwork — a genre
// gradient, a large glyph and the real event title — clearly artwork, never a
// stock or fake photo. Everything printed on it (title, venue, area, date,
// price string) is Swiggy's own text; the genre is only inferred for styling.
// "Directions" opens the venue in Google Maps (venueLat/venueLng from
// get_event_details, else the venue name + address); "Share" sends the event.
// Cards built from get_event_venue_info also show that venue's distance, show
// count, the event's duration / age / seating / languages chips and Swiggy's
// rewards line ("Earn 10% DineCash on ticket booking") — each only when present.
// "✦ Best show" opens the ticket picker already filled with its top AI pick
// (show + ticket + count); the user still taps Review → Confirm.

import { useState } from 'react';
import type { ScenesEvent } from '@/shared/types';
import { directionsUrl } from '@/frontend/utils/maps';
import { shareOrCopy } from '@/frontend/utils/webShare';

export interface ScenesEventCardProps {
  event: ScenesEvent;
  /** autoPick: open the ticket picker already filled with its best AI pick */
  onViewShows?: (event: ScenesEvent, opts?: { autoPick?: boolean }) => void;
  bestReason?: string;
  disabled?: boolean;
}

type Genre = 'comedy' | 'music' | 'party' | 'theatre' | 'workshop' | 'food' | 'sports' | 'kids' | 'other';

const GENRES: Record<Genre, { label: string; glyph: string; from: string; via: string; to: string }> = {
  comedy: { label: 'Comedy', glyph: '🎤', from: '#ff8a3d', via: '#f43f5e', to: '#7c1d4f' },
  music: { label: 'Live music', glyph: '🎸', from: '#6366f1', via: '#8b5cf6', to: '#1e1b4b' },
  party: { label: 'Nightlife', glyph: '🪩', from: '#ec4899', via: '#a21caf', to: '#1f0a33' },
  theatre: { label: 'Theatre & spoken word', glyph: '🎭', from: '#b91c1c', via: '#7f1d1d', to: '#1c0a0a' },
  workshop: { label: 'Workshop', glyph: '🎨', from: '#14b8a6', via: '#0d9488', to: '#134e4a' },
  food: { label: 'Food & drink', glyph: '🍷', from: '#f59e0b', via: '#b45309', to: '#3b1d06' },
  sports: { label: 'Screening & sports', glyph: '🏟️', from: '#22c55e', via: '#15803d', to: '#052e16' },
  kids: { label: 'Family', glyph: '🎈', from: '#38bdf8', via: '#0ea5e9', to: '#0c4a6e' },
  other: { label: 'Event', glyph: '🎟️', from: '#fb7185', via: '#9333ea', to: '#1e1b4b' },
};

/** Styling-only genre guess from the event's own text (title + tags). */
export function genreOf(text: string): Genre {
  const t = text.toLowerCase();
  if (/comed|stand ?up|open ?mic|roast|improv|laugh/.test(t)) return 'comedy';
  if (/workshop|pottery|paint|craft|crochet|resin|candle|terrarium|art\b|class/.test(t)) return 'workshop';
  if (/music|concert|gig|band|jam|unplugged|acoustic|sufi|retro|singer|playback/.test(t)) return 'music';
  if (/party|dj\b|club|techno|edm|night ?life|rave|halloween|hallow/.test(t)) return 'party';
  if (/theat|play\b|drama|musical|poetry|storytell/.test(t)) return 'theatre';
  if (/brunch|food|tasting|wine|beer|dinner|feast/.test(t)) return 'food';
  if (/screening|match|sport|cricket|football|ipl/.test(t)) return 'sports';
  if (/kid|family|children/.test(t)) return 'kids';
  return 'other';
}

/**
 * Generated poster artwork for an event (no Swiggy image exists). `compact`
 * renders the small square used in the ticket picker header.
 */
export function ScenesPoster({
  title,
  hint,
  compact = false,
  children,
}: {
  title: string;
  /** extra text (e.g. tags) that sharpens the genre guess */
  hint?: string;
  compact?: boolean;
  children?: React.ReactNode;
}) {
  const g = GENRES[genreOf(`${title} ${hint ?? ''}`)];
  const background = [
    'radial-gradient(circle at 85% 15%, rgba(255,255,255,0.28) 0, rgba(255,255,255,0) 38%)',
    'radial-gradient(circle at 10% 110%, rgba(0,0,0,0.35) 0, rgba(0,0,0,0) 55%)',
    'repeating-linear-gradient(135deg, rgba(255,255,255,0.05) 0 2px, transparent 2px 14px)',
    `linear-gradient(140deg, ${g.from} 0%, ${g.via} 52%, ${g.to} 100%)`,
  ].join(', ');

  if (compact) {
    return (
      <div
        role="img"
        aria-label={`${g.label} artwork`}
        className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl text-2xl shadow-xs"
        style={{ background }}
      >
        <span aria-hidden>{g.glyph}</span>
      </div>
    );
  }

  return (
    <div
      role="img"
      aria-label={`Illustrated ${g.label.toLowerCase()} poster for ${title || 'this event'}`}
      className="relative flex aspect-[2/1] w-full flex-col justify-between overflow-hidden p-3.5 text-white"
      style={{ background }}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute -right-3 -top-4 select-none text-[88px] leading-none opacity-90 drop-shadow-[0_6px_18px_rgba(0,0,0,0.35)] transition-transform duration-300 group-hover:-rotate-6 group-hover:scale-105"
      >
        {g.glyph}
      </span>
      <span className="relative w-fit rounded-full bg-black/25 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] backdrop-blur-xs">
        {g.label}
      </span>
      <div className="relative">
        <h3 className="max-w-[85%] font-display text-lg font-extrabold leading-tight tracking-tight line-clamp-2 [text-shadow:0_2px_10px_rgba(0,0,0,0.35)]">
          {title || 'Untitled event'}
        </h3>
        {children}
      </div>
    </div>
  );
}

export function ScenesEventCard({ event, onViewShows, bestReason, disabled }: ScenesEventCardProps) {
  const { title, venueName, area, city, venueAddress, dateSummary, priceText, distanceKm, showCount, rewards } = event;
  const where = [area, city].filter(Boolean).join(', ');
  const place = venueName ? [venueName, where].filter(Boolean).join(' · ') : where || venueAddress || '';
  const [copied, setCopied] = useState(false);
  // Only point at a real venue (name / address / coordinates from Swiggy).
  const maps =
    venueName || venueAddress || event.venueLatitude
      ? directionsUrl({ lat: event.venueLatitude, lng: event.venueLongitude, name: venueName, address: venueAddress || where })
      : '';
  const share = async () => {
    const text = [`🎟️ ${title}`, dateSummary, place, priceText, rewards, 'On Swiggy Scenes'].filter(Boolean).join('\n');
    if ((await shareOrCopy({ title, text })) === 'copied') {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="group relative flex flex-col overflow-hidden rounded-xl border border-hairline bg-surface-card transition-all duration-200 hover:border-coral/40 hover:shadow-card">
      {bestReason && (
        <div className="flex items-center gap-1.5 border-b border-coral/20 bg-coral/10 px-3 py-1 text-[11px] font-medium text-coral">
          <span aria-hidden>✦</span>
          <span className="truncate">{bestReason}</span>
        </div>
      )}

      <button
        type="button"
        disabled={disabled || !onViewShows}
        onClick={() => onViewShows?.(event)}
        className="block w-full text-left disabled:cursor-default"
        aria-label={`See shows and tickets for ${title || 'this event'}`}
      >
        <ScenesPoster title={title}>
          {dateSummary && (
            <p className="mt-1 text-[11px] font-medium text-white/85 [text-shadow:0_1px_6px_rgba(0,0,0,0.4)]">
              {dateSummary}
            </p>
          )}
        </ScenesPoster>
      </button>

      <div className="flex flex-1 flex-col p-3.5">
        <div className="flex items-start justify-between gap-3 text-xs text-muted">
          {place ? (
            <div className="flex min-w-0 items-center gap-1.5">
              <span aria-hidden>📍</span>
              <span className="truncate">{place}</span>
            </div>
          ) : (
            <span />
          )}
          {priceText ? (
            <span className="shrink-0 rounded-md bg-coral/10 px-2 py-0.5 text-xs font-bold text-coral">{priceText}</span>
          ) : distanceKm !== undefined ? (
            <span className="shrink-0 text-[11px] font-medium text-muted">{distanceKm} km</span>
          ) : null}
        </div>
        {priceText && distanceKm !== undefined && <p className="mt-0.5 text-[11px] text-muted-soft">{distanceKm} km away</p>}

        {showCount !== undefined && (
          <p className="mt-1.5 text-[11px] font-medium text-coral">
            {showCount} show{showCount === 1 ? '' : 's'} here
          </p>
        )}

        <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[11px]">
          {maps && (
            <a href={maps} target="_blank" rel="noopener noreferrer" className="font-semibold text-muted hover:text-ink">
              🧭 Directions
            </a>
          )}
          <button type="button" onClick={share} className="font-semibold text-muted hover:text-ink">
            {copied ? '✓ Copied' : '↗ Share'}
          </button>
        </div>

        {onViewShows && (
          <div className="mt-auto flex gap-2 pt-3">
            <button
              type="button"
              disabled={disabled}
              onClick={() => onViewShows(event, { autoPick: true })}
              title="Opens the ticket picker with the best show and ticket already selected — you still review and confirm"
              className="flex items-center justify-center gap-1 rounded-lg border border-coral/40 px-3 py-2 text-xs font-semibold text-coral transition-colors hover:bg-coral/10 disabled:opacity-50"
            >
              <span aria-hidden>✦</span>
              <span>Best show</span>
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onViewShows(event)}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-coral/10 py-2 text-xs font-semibold text-coral transition-colors hover:bg-coral hover:text-on-primary disabled:opacity-50"
            >
              <span>See shows & tickets</span>
              <span aria-hidden>→</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default ScenesEventCard;
