'use client';

// Code-split entry points for the chat thread. The landing view (empty thread)
// never renders any of these, so keeping them out of the initial bundle cuts
// the JS parsed before hydration (LCP / TBT on mobile). Each loads on first use
// and is also warmed on idle (preloadChatChunks) so a reply's cards rarely wait.
//
// Markdown uses React.lazy (not next/dynamic) because its fallback needs the
// message text: while the renderer loads, the plain text shows in the same
// typographic box, so nothing blanks or jumps.

import dynamic from 'next/dynamic';
import { lazy, memo, Suspense } from 'react';
import { stripMarkers } from './markers';

/** Reserved-height shimmer while a card's chunk loads (keeps CLS near zero). */
function CardSkeleton() {
  return <div aria-hidden="true" className="skeleton my-1 h-32 w-full" />;
}

const loadMarkdown = () => import('./Markdown');
const RealMarkdown = lazy(() => loadMarkdown().then((m) => ({ default: m.Markdown })));

/** Memoised so a streaming turn never re-parses the other turns' Markdown. */
export const Markdown = memo(function LazyMarkdown({ children }: { children: string }) {
  const plain = stripMarkers(children);
  if (!plain) return null;
  return (
    <Suspense
      fallback={
        <div className="whitespace-pre-wrap text-[15px] leading-relaxed text-body">{plain}</div>
      }
    >
      <RealMarkdown>{children}</RealMarkdown>
    </Suspense>
  );
});

const loaders = {
  menu: () => import('../catalog/MenuList'),
  compare: () => import('../catalog/CompareCard'),
  tracker: () => import('../features/LiveOrderTracker'),
  cook: () => import('../features/CookMode'),
  dineoutResults: () => import('../catalog/DineoutResults'),
  slotPicker: () => import('../catalog/DineoutSlotPicker'),
  scenesCard: () => import('../catalog/ScenesEventCard'),
  shortlist: () => import('../catalog/AiShortlist'),
  showPicker: () => import('../catalog/ScenesShowPicker'),
  itinerary: () => import('./ItineraryCard'),
  booking: () => import('../features/BookingTrackerCard'),
  orders: () => import('../features/OrderHistoryCard'),
  mealPlan: () => import('../cart/FoodMealPlanCard'),
  basket: () => import('../catalog/BasketCard'),
};

export const MenuList = dynamic(() => import('../catalog/MenuList').then((m) => m.MenuList), { loading: CardSkeleton });
export const CompareCard = dynamic(() => import('../catalog/CompareCard').then((m) => m.CompareCard), { loading: CardSkeleton });
export const LiveOrderTracker = dynamic(() => import('../features/LiveOrderTracker').then((m) => m.LiveOrderTracker), { loading: CardSkeleton });
export const CookMode = dynamic(() => import('../features/CookMode').then((m) => m.CookMode), { loading: CardSkeleton });
export const DineoutResults = dynamic(() => import('../catalog/DineoutResults').then((m) => m.DineoutResults), { loading: CardSkeleton });
export const DineoutSlotPicker = dynamic(() => import('../catalog/DineoutSlotPicker').then((m) => m.DineoutSlotPicker), { loading: CardSkeleton });
export const ScenesEventCard = dynamic(() => import('../catalog/ScenesEventCard').then((m) => m.ScenesEventCard), { loading: CardSkeleton });
export const ScenesShortlist = dynamic(() => import('../catalog/AiShortlist').then((m) => m.ScenesShortlist), { loading: CardSkeleton });
export const ScenesShowPicker = dynamic(() => import('../catalog/ScenesShowPicker').then((m) => m.ScenesShowPicker), { loading: CardSkeleton });
export const ItineraryCard = dynamic(() => import('./ItineraryCard').then((m) => m.ItineraryCard), { loading: CardSkeleton });
export const BookingTrackerCard = dynamic(() => import('../features/BookingTrackerCard').then((m) => m.BookingTrackerCard), { loading: CardSkeleton });
export const OrderHistoryCard = dynamic(() => import('../features/OrderHistoryCard').then((m) => m.OrderHistoryCard), { loading: CardSkeleton });
export const FoodMealPlanCard = dynamic(() => import('../cart/FoodMealPlanCard').then((m) => m.FoodMealPlanCard), { loading: CardSkeleton });
export const BasketCard = dynamic(() => import('../catalog/BasketCard').then((m) => m.BasketCard), { loading: CardSkeleton });

let warmed = false;
/**
 * Fetch the chat chunks in the background once the page is idle, so the first
 * reply's Markdown and cards render without a loading flash. Never blocks.
 */
export function preloadChatChunks(): void {
  if (warmed || typeof window === 'undefined') return;
  warmed = true;
  const run = () => {
    void loadMarkdown().catch(() => {});
    for (const load of Object.values(loaders)) void load().catch(() => {});
  };
  const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
    .requestIdleCallback;
  if (ric) ric(run, { timeout: 4000 });
  else window.setTimeout(run, 2500);
}
