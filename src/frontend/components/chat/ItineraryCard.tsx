'use client';

// The Plan tab's outing card in chat — a COMPACT summary. The detail lives in
// the live plan panel (right tray / mobile drawer, LivePlanPanel): each step's
// live status, the AI's picks, the confirms and the activity log. This card
// just shows the stops and hands over: "Open live plan →" focuses the panel,
// "Run plan for me" starts the autonomous run (which still stops for every
// confirm). Nothing here books, pays or orders.

import type {
  ChatMessage,
  DineoutRestaurant,
  Itinerary,
  ItineraryDomain,
  ScenesEvent,
  Service,
} from '@/shared/types';
import { SERVICE_META } from '@/shared/types';
import { openLivePlan, runLivePlan } from '@/frontend/plan/livePlanBus';

// kept for callers / scripts/verify-plan.ts
export { pendingFor, nextStepIndex } from '@/frontend/plan/planRun';

const EMOJI: Record<ItineraryDomain, string> = {
  scenes: SERVICE_META.scenes.emoji,
  dineout: SERVICE_META.dineout.emoji,
  food: SERVICE_META.food.emoji,
  instamart: SERVICE_META.instamart.emoji,
  other: '📍',
};

export interface ItineraryCardProps {
  itinerary: Itinerary;
  // the turn that carries the plan
  message: ChatMessage;
  sending: boolean;
  // (the step actions moved to the live plan panel; still accepted from MessageBubble)
  onViewDineoutSlots?: (restaurant: DineoutRestaurant, opts?: { autoPick?: boolean; planIntent?: string }) => void;
  onViewScenesShows?: (event: ScenesEvent, opts?: { autoPick?: boolean; planIntent?: string }) => void;
  onPick: (text: string, displayText?: string) => void;
  onHandoff?: (service: Service, query: string, label?: string) => void;
  onApproveProposal?: (messageId: string, pid: string) => void;
}

export function ItineraryCard({ itinerary, sending }: ItineraryCardProps) {
  const meta = [itinerary.date, itinerary.party ? `${itinerary.party} people` : '', itinerary.budget ? `₹${itinerary.budget.toLocaleString('en-IN')} budget` : '']
    .filter(Boolean)
    .join(' · ');
  return (
    <div className="mt-3 overflow-hidden rounded-2xl border border-emerald-500/25 bg-emerald-500/[0.03] shadow-xs">
      <div className="flex items-center gap-2 border-b border-hairline/80 px-4 py-3">
        <span className="text-base" aria-hidden="true">
          🗺️
        </span>
        <div className="min-w-0 flex-1">
          <h4 className="truncate font-display text-sm font-semibold text-ink">{itinerary.title || 'Your outing plan'}</h4>
          {meta && <p className="truncate text-[11px] text-muted">{meta}</p>}
        </div>
        <span className="shrink-0 text-[11px] text-muted-soft">
          {itinerary.steps.length} stop{itinerary.steps.length === 1 ? '' : 's'}
        </span>
      </div>

      <ol className="space-y-1 px-4 py-2.5">
        {itinerary.steps.map((s, i) => (
          <li key={`${i}-${s.title}`} className="flex items-baseline gap-2 text-xs">
            <span className="w-14 shrink-0 text-right font-semibold tabular-nums text-ink">{s.time ?? ''}</span>
            <span aria-hidden="true">{EMOJI[s.domain]}</span>
            <span className="min-w-0 truncate text-body">{s.title}</span>
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap items-center gap-2 border-t border-hairline/80 px-4 py-2.5">
        <button
          type="button"
          onClick={runLivePlan}
          disabled={sending}
          className="inline-flex items-center gap-1.5 rounded-full bg-emerald-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-xs transition-colors hover:bg-emerald-700 disabled:opacity-50"
        >
          <span aria-hidden="true">▶</span> Run plan for me
        </button>
        <button
          type="button"
          onClick={openLivePlan}
          className="inline-flex items-center gap-1 rounded-full border border-hairline bg-canvas px-3 py-1.5 text-xs font-semibold text-body transition-colors hover:border-emerald-500/60 hover:text-ink"
        >
          Open live plan <span aria-hidden="true">→</span>
        </button>
      </div>
      <p className="border-t border-hairline/80 px-4 py-2 text-[11px] leading-relaxed text-muted">
        The live plan panel tracks every step as it happens — nothing is booked or ordered until you confirm it.
      </p>
    </div>
  );
}

export default ItineraryCard;
