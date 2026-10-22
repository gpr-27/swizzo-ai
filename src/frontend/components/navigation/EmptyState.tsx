'use client';

// Editorial hero shown before the first message: a large serif greeting tuned to
// the active service, a calm subline, and the service's quick prompts. When the
// tab's proactive briefing has loaded (useHomeBriefing — real orders /
// bookings), it shows under the subline and its three tailored chips replace
// the static prompts; until then (or on any error) the static copy stays.

import type { Service } from '@/shared/types';
import type { HomeBriefingData } from '@/frontend/hooks/useHomeBriefing';
import { HomeBriefing } from './HomeBriefing';
import { SpikeMark } from './SpikeMark';

const COPY: Record<Service, { title: string; subtitle: string }> = {
  instamart: {
    title: 'What are we cooking today?',
    subtitle:
      "Tell me what you need and I'll pull the freshest picks from Instamart — then just tap Add.",
  },
  food: {
    title: 'What are you craving?',
    subtitle:
      "Name a dish or cuisine and I'll line up the best places to order from.",
  },
  dineout: {
    title: 'Where would you like to dine?',
    subtitle:
      "Discover top tables, reserve slots, and unlock up to 50% dining discounts with Dineout.",
  },
  scenes: {
    title: 'Ready for live experiences?',
    subtitle:
      "Discover standup comedy, music gigs, theatre, and exclusive screenings across town.",
  },
  plan: {
    title: 'Plan an outing, end to end.',
    subtitle:
      "Tell me who's going, when, where and your budget — I'll line up a show, a table, dinner home and snacks as one timeline. You confirm every booking.",
  },
};

export interface EmptyStateProps {
  service: Service;
  suggestions: string[];
  onPick: (text: string, displayText?: string) => void;
  briefing?: HomeBriefingData | null;
}

export function EmptyState({ service, suggestions, onPick, briefing }: EmptyStateProps) {
  const copy = COPY[service];
  const chips =
    briefing && briefing.briefing.chips.length
      ? briefing.briefing.chips.map((c) => ({ label: c.label, prompt: c.prompt }))
      : suggestions.map((s) => ({ label: s, prompt: s }));

  return (
    <div className="flex h-full flex-col items-center justify-center px-6 py-16 text-center animate-rise">
      <span className="mb-7 inline-flex h-12 w-12 items-center justify-center rounded-full bg-coral/10 text-coral">
        <SpikeMark className="h-6 w-6" />
      </span>

      <h1 className="font-display text-4xl leading-tight text-ink sm:text-5xl">
        {copy.title}
      </h1>
      <p className="mt-4 max-w-md text-base text-muted">{copy.subtitle}</p>

      {briefing?.briefing.hasData && (
        <div className="mt-7 flex w-full justify-center">
          <HomeBriefing data={briefing} onPick={onPick} hideChips />
        </div>
      )}

      <div className={`${briefing?.briefing.hasData ? 'mt-4' : 'mt-9'} flex max-w-lg flex-wrap items-center justify-center gap-2.5`}>
        {chips.map(({ label: ex, prompt }) => (
          <button
            key={ex}
            type="button"
            onClick={() => onPick(prompt, prompt === ex ? undefined : ex)}
            className="rounded-full border border-hairline bg-surface-card/60 px-4 py-2 text-sm text-body transition-colors hover:border-coral hover:text-coral"
          >
            {ex}
          </button>
        ))}
      </div>
    </div>
  );
}

export default EmptyState;
