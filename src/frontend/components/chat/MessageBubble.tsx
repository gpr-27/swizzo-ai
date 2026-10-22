'use client';

// Renders a single chat turn. User turns are right-aligned pills; assistant
// turns are left-aligned, prefixed with the spike-mark avatar, and may carry a
// service-specific card cluster: Instamart product/suggestion grids, Food
// restaurant cards + menus, or Dineout restaurant cards. The shell threads each
// card's action callbacks down from the hook.

import { useState } from 'react';
import type {
  BookingTrackerExtras,
  ChatMessage,
  CompareItem,
  DineoutRestaurant,
  DineoutSlotChoice,
  FoodRestaurant,
  MenuItem,
  Product,
  ScenesEvent,
  ScenesOrderOutcome,
  Variation,
} from '@/shared/types';
// Direct imports (not the components barrel, which re-exports this file).
import { ProductGrid } from '../catalog/ProductGrid';
import { FoodRestaurantCard } from '../catalog/FoodRestaurantCard';
import { RevealList } from '../catalog/RevealList';
import { SpikeMark } from '../navigation/SpikeMark';
import { PickerPopup } from '../features/PickerPopup';
import { TypingDots } from './TypingDots';
import { stripMarkers } from './markers';
import { ModelBadge } from './ModelBadge';
import { SERVICE_META, type Service } from '@/shared/types';
import type { BasketAction } from '../catalog/BasketCard';
// Service-specific cards + the Markdown renderer are code-split (./lazy).
import {
  Markdown,
  MenuList,
  CompareCard,
  LiveOrderTracker,
  CookMode,
  DineoutResults,
  DineoutSlotPicker,
  ScenesEventCard,
  ScenesShortlist,
  ScenesShowPicker,
  ItineraryCard,
  BookingTrackerCard,
  OrderHistoryCard,
  FoodMealPlanCard,
  BasketCard,
} from './lazy';

export interface MessageBubbleProps {
  message: ChatMessage;
  // a turn is streaming — disables agent-triggering buttons inside the cards
  sending: boolean;
  // instamart
  inCartQty: (spinId: string) => number;
  onAdd: (product: Product, variation: Variation) => void;
  onLoadMore: (messageId: string, groupIndex: number) => void;
  isLoadingMore: (messageId: string, groupIndex: number) => boolean;
  // food
  openMenu: (restaurant: FoodRestaurant) => void;
  // restaurant menu "More" (next category page)
  onLoadMoreMenu?: (messageId: string) => void;
  isLoadingMoreMenu?: (messageId: string) => boolean;
  onLoadMoreDishes?: (messageId: string, groupIndex: number) => void;
  isLoadingMoreDishes?: (messageId: string, groupIndex: number) => boolean;
  addFoodItem: (item: MenuItem) => void;
  inFoodCartQty: (menuItemId: string) => number;
  // send a follow-up turn (e.g. the "Best pick" action, or a clarify chip)
  onPick: (text: string, displayText?: string) => void;
  // compare ("choose best of both")
  isSelected: (spinId: string) => boolean;
  onToggleCompare: (product: Product, variation: Variation) => void;
  onToggleCompareFood: (item: MenuItem) => void;
  // "Add winner" on the Compare card → hook.addCompareWinner
  onAddCompareWinner: (item: CompareItem) => void;
  // approval-gated cart proposals
  onApproveProposal: (messageId: string, pid: string) => void;
  onDismissProposal: (messageId: string, pid: string) => void;
  onApproveAll: (messageId: string) => void;
  // "Try again" — re-run this assistant reply in place
  onRegenerate?: (messageId: string) => void;
  // dineout
  onViewDineoutSlots?: (restaurant: DineoutRestaurant) => void;
  onBookDineoutSlot?: (
    restaurantId: string,
    restaurantName: string,
    choice: DineoutSlotChoice,
    guestCount: number,
  ) => Promise<boolean> | void;
  // scenes
  onViewScenesShows?: (event: ScenesEvent) => void;
  // the ticket picker placed an order (UPI → open payment sheet; FREE → booking card)
  onBookScenesShow?: (
    eventId: string,
    eventTitle: string,
    outcome: ScenesOrderOutcome,
    ticketTitle: string,
    guestCount: number,
    extra?: BookingTrackerExtras,
  ) => void;
  // off-domain ask / plan step → open the owning tab (fresh thread) with the query
  onHandoff?: (service: Service, query: string, label?: string) => void;
  // Instamart AI basket card (Approve all / dismiss)
  onBasketAction?: (messageId: string, action: BasketAction) => void;
}

/** Compact per-message stamp, e.g. "10:07 AM · Jun 30". */
function formatStamp(ts?: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const date = d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  return `${time} · ${date}`;
}

export function MessageBubble({
  message,
  sending,
  inCartQty,
  onAdd,
  onLoadMore,
  isLoadingMore,
  openMenu,
  onLoadMoreMenu,
  isLoadingMoreMenu,
  onLoadMoreDishes,
  isLoadingMoreDishes,
  addFoodItem,
  inFoodCartQty,
  onPick,
  isSelected,
  onToggleCompare,
  onToggleCompareFood,
  onAddCompareWinner,
  onApproveProposal,
  onDismissProposal,
  onApproveAll,
  onRegenerate,
  onViewDineoutSlots,
  onBookDineoutSlot,
  onViewScenesShows,
  onBookScenesShow,
  onHandoff,
  onBasketAction,
}: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const [copied, setCopied] = useState(false);
  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(stripMarkers(message.text));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };
  const stamp = formatStamp(message.createdAt);

  if (isUser) {
    return (
      <div className="flex justify-end animate-rise">
        <div className="flex max-w-[80%] flex-col items-end gap-2">
          {/* The photo the user attached on this turn — always shown so the sent
              image is visible (fixes "I can't see my uploaded image"). */}
          {message.image && (
            // eslint-disable-next-line @next/next/no-img-element
            <img decoding="async"
              src={`data:${message.image.mediaType};base64,${message.image.data}`}
              alt="Your attached photo"
              loading="lazy"
              className="max-h-60 w-auto max-w-full rounded-lg border border-hairline object-cover"
            />
          )}
          {(message.displayText || message.text) && (
            <div className="whitespace-pre-wrap rounded-2xl rounded-tr-sm bg-surface-card/80 border border-hairline/90 px-4 py-2.5 text-[15px] leading-relaxed text-ink shadow-xs">
              {/* Show the short label for action turns; the full instruction is
                  kept in `text` for the agent but never shown to the user. */}
              {message.displayText ?? message.text}
            </div>
          )}
          {stamp && (
            <span className="px-1 text-[11px] text-muted-soft">{stamp}</span>
          )}
        </div>
      </div>
    );
  }

  const showDots = message.pending && !message.text;

  // "Try again" only makes sense for a streamed agent turn. Client-built
  // messages (booking confirmations, payment success, local approve-all
  // replies) have no prompt of their own — regenerating them would re-ask an
  // unrelated earlier message and drop everything after it. Streamed turns get
  // hook ids (`id-…`); an explicit `synthetic` flag is honoured when present.
  const synthetic =
    (message as ChatMessage & { synthetic?: boolean }).synthetic === true ||
    !message.id.startsWith('id-');
  const canRegenerate = !!onRegenerate && !synthetic;

  // Best/healthy/warn reasons can land on a turn that shows no grid/menu (e.g.
  // a verdict about compared items). Surface them as text so they're not lost.
  const hasItemCards = Boolean(
    message.productGroups?.length ||
      message.suggestions?.length ||
      message.menu?.categories.length ||
      message.dishGroups?.length,
  );
  const orphanMarks = hasItemCards
    ? []
    : [
        ...Object.values(message.bestPicks ?? {}).map((r) => ({ kind: 'best' as const, r })),
        ...Object.values(message.healthyPicks ?? {}).map((r) => ({ kind: 'healthy' as const, r })),
        ...Object.values(message.warns ?? {}).map((r) => ({ kind: 'warn' as const, r })),
      ];

  // Plan replies: the itinerary + live panel are the answer; the raw search
  // cards the planner used fold behind one line each instead of flooding chat.
  const researchFold = !!message.itinerary && message.itinerary.steps.length > 0;

  return (
    <div id={`msg-${message.id}`} className="flex scroll-mt-24 gap-3 animate-rise">
      <span className="mt-0.5 hidden h-8 w-8 shrink-0 sm:inline-flex items-center justify-center rounded-xl bg-gradient-to-br from-coral/20 via-amber-500/10 to-coral/20 text-coral ring-1 ring-coral/30 shadow-xs">
        <SpikeMark className="h-4 w-4" />
      </span>

      <div className="min-w-0 flex-1">
        {message.status && (
          <p role="status" aria-live="polite" className="mb-1.5 text-sm italic text-muted-soft">
            {message.status}
          </p>
        )}

        {showDots ? (
          <TypingDots className="py-1.5" />
        ) : (
          message.text && <Markdown>{message.text}</Markdown>
        )}

        {/* Off-domain ask → one tap opens the tab that owns it */}
        {message.handoffs && message.handoffs.length > 0 && onHandoff && (
          <div className="mt-2.5 flex flex-wrap gap-2">
            {message.handoffs.map((h) => (
              <button
                key={h.service}
                type="button"
                onClick={() => onHandoff(h.service, h.query, h.query)}
                className="inline-flex items-center gap-1.5 rounded-full bg-coral px-3.5 py-1.5 text-xs font-semibold text-on-primary shadow-soft transition-all hover:bg-coral-active"
              >
                <span aria-hidden="true">{SERVICE_META[h.service].emoji}</span>
                {h.label ?? `Open in ${SERVICE_META[h.service].label}`}
                <span aria-hidden="true">→</span>
              </button>
            ))}
          </div>
        )}

        {/* Plan tab — the outing timeline; steps hand off to each service's flow */}
        {message.itinerary && message.itinerary.steps.length > 0 && (
          <ItineraryCard
            itinerary={message.itinerary}
            message={message}
            sending={sending}
            onViewDineoutSlots={onViewDineoutSlots}
            onViewScenesShows={onViewScenesShows}
            onPick={onPick}
            onHandoff={onHandoff}
            onApproveProposal={onApproveProposal}
          />
        )}

        {orphanMarks.length > 0 && (
          <ul className="mt-2 space-y-1">
            {orphanMarks.map((m, idx) => (
              <li
                key={`${m.kind}-${idx}`}
                className={`flex items-start gap-1.5 text-[13px] leading-snug ${
                  m.kind === 'warn'
                    ? 'text-error'
                    : m.kind === 'healthy'
                      ? 'text-success-ink'
                      : 'text-body'
                }`}
              >
                <span aria-hidden="true" className={m.kind === 'best' ? 'text-coral' : ''}>
                  {m.kind === 'best' ? '✦' : m.kind === 'healthy' ? '🥗' : '⚠'}
                </span>
                <span>
                  <span className="font-medium">
                    {m.kind === 'best' ? 'Best pick' : m.kind === 'healthy' ? 'Healthiest' : 'Heads-up'}
                  </span>{' '}
                  — {m.r}
                </span>
              </li>
            ))}
          </ul>
        )}

        {/* Instamart — the AI basket: one card for the whole shop */}
        {message.basket && onBasketAction && (
          <BasketCard
            basket={message.basket}
            sending={sending}
            onAction={(a) => onBasketAction(message.id, a)}
            onAsk={onPick}
          />
        )}

        {/* Food — the AI-built whole order (one proposal: Approve all / tweak) */}
        {message.foodMealPlan && message.foodMealPlan.items.length > 0 && (
          <FoodMealPlanCard messageId={message.id} plan={message.foodMealPlan} />
        )}

        {/* Approval-gated cart proposals — only render when items are actually added or pending */}
        {(() => {
          const rawProposals = message.proposals ?? [];
          const proposals = rawProposals.filter((p) => p && typeof p.name === 'string' && p.name.trim().length > 0);
          if (proposals.length === 0) return null;

          const pending = proposals.filter((p) => p.status === 'pending');
          const approved = proposals.filter((p) => p.status === 'approved');

          // Strict guard: only show if there are pending proposals or confirmed added items
          if (pending.length === 0 && approved.length === 0) return null;

          const allApproved = pending.length === 0 && approved.length > 0;
          const displayItems = pending.length > 0 ? proposals.filter((p) => p.status !== 'dismissed') : approved;
          if (displayItems.length === 0) return null;

          return (
            <div
              className={`mt-3.5 overflow-hidden rounded-xl border p-3.5 transition-all duration-300 ${
                allApproved
                  ? 'border-success/30 bg-success/[0.04] shadow-sm'
                  : 'border-coral/30 bg-coral/[0.04] shadow-sm'
              }`}
            >
              <div className="mb-2.5 flex items-center justify-between gap-2">
                <span
                  className={`flex items-center gap-1.5 text-xs font-semibold tracking-wide ${
                    allApproved ? 'text-success-ink' : 'text-coral'
                  }`}
                >
                  <span className="text-sm" aria-hidden="true">{allApproved ? '✓' : '✦'}</span>
                  {pending.length > 0
                    ? 'Approve to add to your cart'
                    : `${approved.length} ${approved.length === 1 ? 'item' : 'items'} added to cart ✓`}
                </span>
                {pending.length > 1 && (
                  <button
                    type="button"
                    onClick={() => onApproveAll(message.id)}
                    className="rounded-full bg-coral px-3 py-1 text-xs font-semibold text-on-primary shadow-soft transition-all hover:bg-coral-active hover:shadow-md"
                  >
                    Approve all
                  </button>
                )}
              </div>
              <ul className="space-y-2">
                {displayItems.map((p) => (
                  <li
                    key={p.pid}
                    className="flex items-center gap-3 rounded-lg border border-hairline/80 bg-canvas/80 px-3 py-2 shadow-xs transition-colors hover:border-hairline"
                  >
                    <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-surface-soft border border-hairline/50">
                      {p.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img decoding="async"
                          src={p.imageUrl}
                          alt=""
                          className="h-full w-full object-contain p-0.5"
                        />
                      ) : (
                        <span className="font-semibold text-coral text-base" aria-hidden="true">
                          {p.kind === 'remove' ? '–' : '+'}
                        </span>
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-ink">{p.name}</span>
                      {p.detail && (
                        <span className="block truncate text-[11px] text-muted-soft">
                          {p.detail}
                        </span>
                      )}
                    </span>
                    {p.status === 'pending' ? (
                      <span className="flex shrink-0 items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => onApproveProposal(message.id, p.pid)}
                          className="rounded-full bg-coral px-3 py-1 text-xs font-medium text-on-primary transition-colors hover:bg-coral-active"
                        >
                          {p.kind === 'remove' ? 'Remove' : 'Add'}
                        </button>
                        <button
                          type="button"
                          onClick={() => onDismissProposal(message.id, p.pid)}
                          aria-label="Dismiss"
                          className="rounded-full p-1 text-muted-soft transition-colors hover:text-ink hover:bg-surface-card"
                        >
                          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M18 6 6 18M6 6l12 12" />
                          </svg>
                        </button>
                      </span>
                    ) : (
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                          p.status === 'approved' ? 'bg-success/15 text-success-ink' : 'bg-surface-card text-muted-soft'
                        }`}
                      >
                        {p.status === 'approved'
                          ? p.kind === 'remove'
                            ? 'Removed ✓'
                            : 'Added ✓'
                          : 'Dismissed'}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          );
        })()}

        {/* Live order tracking */}
        {message.tracker && (
          <div className="mt-3">
            <LiveOrderTracker
              status={message.tracker.status}
              eta={message.tracker.eta}
              partner={message.tracker.partner}
              items={message.tracker.items}
              trackUrl={message.tracker.trackUrl}
              progress={message.tracker.progress}
              service={message.tracker.service}
            />
          </div>
        )}

        {/* Cook-with-me step-by-step guide */}
        {message.cookSteps && message.cookSteps.length > 0 && (
          <div className="mt-3">
            <CookMode steps={message.cookSteps} />
          </div>
        )}

        {/* Compare ("choose best of both") — a side-by-side matrix + verdict */}
        {message.compareItems && message.compareItems.length > 0 && (
          <div className="mt-3">
            <CompareCard
              items={message.compareItems}
              result={message.comparison}
              onAddWinner={onAddCompareWinner}
            />
          </div>
        )}

        {/* Instamart — one product grid per search (e.g. each ingredient) */}
        {message.productGroups?.map((group, gi) => (
          <Fold key={`g-${gi}`} on={researchFold} label={`Products the AI checked · ${group.query}`}>
            <ProductGrid
              products={group.products}
              query={group.query}
              nextOffset={group.nextOffset}
              loadingMore={isLoadingMore(message.id, gi)}
              sending={sending}
              inCartQty={inCartQty}
              onAdd={onAdd}
              onLoadMore={() => onLoadMore(message.id, gi)}
              isSelected={isSelected}
              onToggleCompare={onToggleCompare}
              bestReason={(id) => message.bestPicks?.[id]}
              healthyReason={(id) => message.healthyPicks?.[id]}
              warnReason={(id) => message.warns?.[id]}
              onFindBest={() =>
                onPick(
                  `From the "${group.query}" options, which is the single best value? Recommend one and mark it.`,
                  'Best pick',
                )
              }
              onHealthier={() =>
                onPick(
                  `Among the "${group.query}" options, which is the healthiest choice — and is there a better/healthier swap? Mark the healthiest.`,
                  'Healthier options',
                )
              }
            />
          </Fold>
        ))}

        {/* Instamart — "your usuals" suggestions */}
        {message.suggestions && message.suggestions.length > 0 && (
          <div className="mt-3">
            <ProductGrid
              products={message.suggestions}
              query="your usuals"
              sending={sending}
              inCartQty={inCartQty}
              onAdd={onAdd}
              isSelected={isSelected}
              onToggleCompare={onToggleCompare}
              bestReason={(id) => message.bestPicks?.[id]}
              healthyReason={(id) => message.healthyPicks?.[id]}
              warnReason={(id) => message.warns?.[id]}
              onFindBest={() =>
                onPick(
                  'Which of my usuals is the best pick to reorder right now? Recommend one and mark it.',
                  'Best pick',
                )
              }
              onHealthier={() =>
                onPick(
                  'Which of my usuals is the healthiest pick, and any better swap? Mark the healthiest.',
                  'Healthier options',
                )
              }
            />
          </div>
        )}

        {/* Food — restaurant cards (show a few, reveal more) */}
        {message.foodRestaurants && message.foodRestaurants.length > 0 && (
          <Fold on={researchFold} label={`Restaurants the AI compared (${message.foodRestaurants.length})`}>
            <RevealList
              items={message.foodRestaurants}
              initial={4}
              step={4}
              className="grid grid-cols-1 gap-3 sm:grid-cols-2"
            >
              {(r) => (
                <FoodRestaurantCard
                  key={r.id}
                  restaurant={r}
                  onViewMenu={openMenu}
                />
              )}
            </RevealList>
          </Fold>
        )}

        {/* Food — restaurant menu */}
        {message.menu && message.menu.categories.length > 0 && (
          <Fold on={researchFold} label={`${message.menu.restaurantName || 'Restaurant'} menu the AI read`}>
            <MenuList
              restaurantId={message.menu.restaurantId}
              restaurantName={message.menu.restaurantName}
              restaurant={message.menu.restaurant}
              totalCategories={message.menu.totalCategories}
              categories={message.menu.categories}
              sending={sending}
              onLoadMore={message.menu.hasMore && onLoadMoreMenu ? () => onLoadMoreMenu(message.id) : undefined}
              loadingMore={isLoadingMoreMenu?.(message.id)}
              loadMoreLabel="More categories"
              onSearchCategory={(title) =>
                onPick(
                  `Show more "${title}" dishes at ${message.menu!.restaurantName} (search_menu with restaurantIdOfAddedItem ${message.menu!.restaurantId}).`,
                  `More ${title}`,
                )
              }
              inCartQty={inFoodCartQty}
              onAdd={addFoodItem}
              bestReason={(id) => message.bestPicks?.[id]}
              healthyReason={(id) => message.healthyPicks?.[id]}
              warnReason={(id) => message.warns?.[id]}
              onFindBest={() =>
                onPick(
                  `From ${message.menu!.restaurantName}'s menu, which dish is the best pick? Recommend one and mark it.`,
                  'Best dish',
                )
              }
              onHealthier={() =>
                onPick(
                  `From ${message.menu!.restaurantName}'s menu, which dish is the healthiest (calories/macros), and is there a lighter option? Mark the healthiest.`,
                  'Healthier options',
                )
              }
              isSelectedForCompare={isSelected}
              onToggleCompare={onToggleCompareFood}
            />
          </Fold>
        )}

        {/* Food — cross-restaurant dish search */}
        {message.dishGroups?.map((g, gi) => (
          <Fold key={`dish-${gi}`} on={researchFold} label="Dishes the AI compared">
            <MenuList
              restaurantId=""
              restaurantName=""
              heading={`Top “${g.query}” near you`}
              showRestaurant
              categories={[{ title: 'Dishes', items: g.dishes }]}
              totalItems={g.totalItems}
              sending={sending}
              onLoadMore={g.nextOffset != null && onLoadMoreDishes ? () => onLoadMoreDishes(message.id, gi) : undefined}
              loadingMore={isLoadingMoreDishes?.(message.id, gi)}
              loadMoreLabel={`More “${g.query}” dishes`}
              inCartQty={inFoodCartQty}
              onAdd={addFoodItem}
              bestReason={(id) => message.bestPicks?.[id]}
              healthyReason={(id) => message.healthyPicks?.[id]}
              warnReason={(id) => message.warns?.[id]}
              onFindBest={() =>
                onPick(
                  `Of these ${g.query} dishes, which is the single best pick? Recommend one and mark it.`,
                  'Best dish',
                )
              }
              onHealthier={() =>
                onPick(
                  `Of these ${g.query} dishes, which is the healthiest? Mark it.`,
                  'Healthier options',
                )
              }
              isSelectedForCompare={isSelected}
              onToggleCompare={onToggleCompareFood}
            />
          </Fold>
        ))}

        {/* Dineout — restaurant cards */}
        {message.dineoutRestaurants && message.dineoutRestaurants.length > 0 && (
          <Fold on={researchFold} label={`Restaurants the AI compared (${message.dineoutRestaurants.length})`}>
            {/* BEST pick first, then Swiggy's order; "Load more" pages via offset */}
            <DineoutResults
              restaurants={message.dineoutRestaurants}
              paging={message.dineoutPaging}
              bestPicks={message.bestPicks}
              onViewSlots={onViewDineoutSlots}
            />
          </Fold>
        )}

        {/* cards already on screen earlier — link instead of drawing them twice */}
        {message.shownAbove && message.shownAbove.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {message.shownAbove.map((x) => (
              <button
                key={`${x.messageId}-${x.label}`}
                type="button"
                onClick={() =>
                  document.getElementById(`msg-${x.messageId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                }
                className="rounded-full border border-hairline px-3 py-1 text-xs text-muted transition-colors hover:border-coral/40 hover:text-ink"
              >
                {x.label} — shown above ↑
              </button>
            ))}
          </div>
        )}

        {/* the picker moved down to the latest reply */}
        {message.pickerMoved && (
          <p className="mt-2 text-xs italic text-muted-soft">
            {message.pickerMoved === 'dineout' ? 'Slot picker' : 'Ticket picker'} moved to your latest message ↓
          </p>
        )}

        {/* Dineout — available slots picker */}
        {message.dineoutSlots && (
          <div className="mt-3">
            <PickerPopup
              messageId={message.id}
              emoji="🍽️"
              title={`Table at ${message.dineoutSlots.restaurantName}`}
              subtitle="Pick a day, time and offer"
              cta="Choose slot"
            >
              <DineoutSlotPicker view={message.dineoutSlots} messageId={message.id} onBookSlot={onBookDineoutSlot} />
            </PickerPopup>
          </div>
        )}

        {/* Scenes — genre chips from discover_events (tap → get_events_collection) */}
        {message.scenesCollections && message.scenesCollections.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {message.scenesCollections.map((c) => (
              <button
                key={c.id}
                type="button"
                disabled={sending}
                onClick={() =>
                  onPick(
                    `Show me all "${c.label}" events — call get_events_collection with collectionIdentifier "${c.id}".`,
                    c.label,
                  )
                }
                className="rounded-full border border-hairline bg-surface-card/60 px-3 py-1 text-xs font-medium text-body transition-colors hover:border-coral/50 hover:text-ink disabled:opacity-50"
              >
                {c.label}
              </button>
            ))}
          </div>
        )}

        {/* Scenes — live events list */}
        {message.scenesEvents && message.scenesEvents.length > 0 && (
          <Fold on={researchFold} label={`Events the AI checked (${message.scenesEvents.length})`}>
            {/* AI shortlist (ranked from these cards) with one-tap "Best show" */}
            <ScenesShortlist events={message.scenesEvents} bestPicks={message.bestPicks} onViewShows={onViewScenesShows} />
            <RevealList
              items={message.scenesEvents}
              initial={4}
              step={4}
              className="grid grid-cols-1 gap-3 sm:grid-cols-2"
            >
              {(e) => (
                <ScenesEventCard
                  key={e.id}
                  event={e}
                  bestReason={message.bestPicks?.[e.id]}
                  onViewShows={onViewScenesShows}
                />
              )}
            </RevealList>
          </Fold>
        )}

        {/* Scenes — show & ticket picker (cart summary → confirm → pay / free) */}
        {message.scenesShows && (
          <div className="mt-3">
            <PickerPopup
              messageId={message.id}
              title={message.scenesShows.eventTitle || 'Shows & tickets'}
              subtitle={[message.scenesShows.venueName, message.scenesShows.dateSummary].filter(Boolean).join(' · ') || 'Pick a show and tickets'}
              cta="Choose tickets"
            >
              <ScenesShowPicker listing={message.scenesShows} messageId={message.id} onOrderPlaced={onBookScenesShow} />
            </PickerPopup>
          </div>
        )}

        {/* Universal Booking Tracker (Dineout Table / Scenes Pass) */}
        {message.bookingTracker && <BookingTrackerCard tracker={message.bookingTracker} />}

        {/* "My bookings": every booking made in this app, live status */}
        {message.bookingTrackers && message.bookingTrackers.length > 0 && (
          <div className="mt-1 space-y-0">
            {message.bookingTrackers.map((t) => (
              <BookingTrackerCard key={`${t.kind}-${t.orderId}`} tracker={t} />
            ))}
          </div>
        )}

        {/* Past / active orders (all of them) */}
        {message.orderHistory && message.orderHistory.orders.length > 0 && (
          <OrderHistoryCard history={message.orderHistory} onAsk={onPick} />
        )}

        {/* Inline clarify / follow-up chips — modern interactive suggestion pills */}
        {message.chips && message.chips.length > 0 && (
          <div className="mt-3.5 flex flex-wrap gap-2">
            {message.chips.map((c) => (
              // Not disabled mid-stream: the hook QUEUES a chip tapped while a
              // reply is streaming (same as typed text) and sends it after.
              <button
                key={c}
                type="button"
                onClick={() => onPick(c)}
                className="tap group inline-flex items-center gap-1.5 rounded-full border border-hairline/90 bg-surface-card/60 px-3.5 py-1.5 text-xs font-semibold text-body shadow-xs transition-all duration-200 hover:-translate-y-0.5 hover:border-coral/60 hover:bg-canvas hover:text-coral hover:shadow-sm active:scale-95"
              >
                <span>{c}</span>
              </button>
            ))}
          </div>
        )}

        {/* Message actions — copy the reply, try again, the model that wrote it,
            + the timestamp. The model badge shows on every finished reply. */}
        {!message.pending && (message.text || message.generatedBy) && (
          <div className="mt-2.5 flex flex-wrap items-center gap-2 text-muted-soft sm:gap-1">
            {message.text && (
            <button
              type="button"
              onClick={copyText}
              title={copied ? 'Copied' : 'Copy'}
              aria-label="Copy reply"
              className="tap inline-flex h-9 w-9 items-center justify-center rounded-md transition-colors hover:bg-surface-card hover:text-ink sm:h-7 sm:w-7"
            >
              {copied ? (
                <svg viewBox="0 0 24 24" className="h-4 w-4 text-coral" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="m20 6-11 11-5-5" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="9" y="9" width="11" height="11" rx="2" />
                  <path d="M5 15V5a2 2 0 0 1 2-2h10" />
                </svg>
              )}
            </button>
            )}
            {canRegenerate && onRegenerate && (
              <button
                type="button"
                onClick={() => onRegenerate(message.id)}
                disabled={sending}
                title="Try again"
                aria-label="Regenerate reply"
                className="tap inline-flex h-9 w-9 items-center justify-center rounded-md transition-colors hover:bg-surface-card hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 sm:h-7 sm:w-7"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
              </button>
            )}
            {message.generatedBy && (
              <span className="ml-1 min-w-0">
                <ModelBadge info={message.generatedBy} />
              </span>
            )}
            {stamp && <span className="ml-1 text-[11px]">{stamp}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

export default MessageBubble;

// A card block that is either shown as-is or, under a Plan itinerary, folded
// behind a one-line summary the user can open.
function Fold({ on, label, children }: { on: boolean; label: string; children: React.ReactNode }) {
  if (!on) return <div className="mt-3">{children}</div>;
  return (
    <details className="group mt-2 rounded-xl border border-hairline bg-surface-card/40 px-3 py-2">
      <summary className="cursor-pointer list-none text-xs text-muted transition-colors hover:text-ink">
        <span className="mr-1 inline-block transition-transform group-open:rotate-90">›</span>
        {label}
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}
