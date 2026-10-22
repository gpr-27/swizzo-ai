'use client';

// The scrollable conversation column. Maps messages to bubbles, shows the
// empty-state hero before the first turn, and keeps the view pinned to the
// newest message as the conversation (and streaming text) grows. Card action
// callbacks for every service are threaded through to each MessageBubble.

import { memo, useEffect, useMemo, useRef, type ReactNode } from 'react';
import type {
  ChatMessage,
  CompareItem,
  DineoutRestaurant,
  DineoutSlotChoice,
  FoodRestaurant,
  MenuItem,
  Product,
  ScenesEvent,
  Service,
  Variation,
} from '@/shared/types';
// Direct imports (not the components barrel, which re-exports this file).
import { EmptyState } from '../navigation/EmptyState';
import { MessageBubble, type MessageBubbleProps } from './MessageBubble';
import { ErrorBoundary } from '@/frontend/components/features/ErrorBoundary';
import { preloadChatChunks } from './lazy';
import { stripMarkers } from './markers';

// Memoised bubble: while a reply streams only the streaming turn's object
// changes, so every other turn skips re-rendering (long chats stay smooth).
const Bubble = memo(MessageBubble);

// Turns older than this many from the end are painted lazily by the browser
// (content-visibility) — an off-screen-only cost, no JS virtualisation.
const LIVE_TAIL = 10;

type ActionKey =
  | 'onAdd' | 'onLoadMore' | 'openMenu' | 'onLoadMoreMenu' | 'onLoadMoreDishes'
  | 'addFoodItem' | 'onPick' | 'onToggleCompare' | 'onToggleCompareFood'
  | 'onAddCompareWinner' | 'onApproveProposal' | 'onDismissProposal' | 'onApproveAll'
  | 'onRegenerate' | 'onViewDineoutSlots' | 'onBookDineoutSlot' | 'onViewScenesShows'
  | 'onBookScenesShow' | 'onHandoff' | 'onBasketAction';
type Actions = Pick<ChatThreadProps, ActionKey>;

/**
 * Identity-stable wrappers for the action callbacks (they're only invoked from
 * events, so always calling the latest prop is exact). Optional callbacks stay
 * undefined when absent so cards still hide their buttons. Query props like
 * inCartQty are NOT wrapped: their identity changing is what re-renders a card.
 */
function useStableActions<T extends Actions>(actions: T): T {
  const latest = useRef(actions);
  useEffect(() => {
    latest.current = actions;
  });
  const stable = useMemo(() => {
    const out: Record<string, (...args: unknown[]) => unknown> = {};
    for (const k of Object.keys(actions)) {
      out[k] = (...args: unknown[]) =>
        (latest.current[k as ActionKey] as ((...a: unknown[]) => unknown) | undefined)?.(...args);
    }
    return out;
    // the key set is fixed by the props interface
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const result = {} as Record<string, unknown>;
  for (const k of Object.keys(actions) as ActionKey[]) {
    result[k] = actions[k] ? stable[k] : undefined;
  }
  return result as T;
}

export interface ChatThreadProps {
  messages: ChatMessage[];
  // a turn is streaming — disables agent-triggering buttons inside the cards
  sending: boolean;
  // instamart
  inCartQty: (spinId: string) => number;
  onAdd: (product: Product, variation: Variation) => void;
  onLoadMore: (messageId: string, groupIndex: number) => void;
  isLoadingMore: (messageId: string, groupIndex: number) => boolean;
  // food
  openMenu: (restaurant: FoodRestaurant) => void;
  onLoadMoreMenu?: (messageId: string) => void;
  isLoadingMoreMenu?: (messageId: string) => boolean;
  onLoadMoreDishes?: (messageId: string, groupIndex: number) => void;
  isLoadingMoreDishes?: (messageId: string, groupIndex: number) => boolean;
  addFoodItem: (item: MenuItem) => void;
  inFoodCartQty: (menuItemId: string) => number;
  // composer / empty-state seed
  onPick: (text: string, displayText?: string) => void;
  suggestions: string[];
  service: Service;
  /** When set (Instamart board), replaces the chat empty-state hero. */
  emptyBoard?: ReactNode;
  // compare ("choose best of both")
  isSelected: (spinId: string) => boolean;
  onToggleCompare: (product: Product, variation: Variation) => void;
  onToggleCompareFood: (item: MenuItem) => void;
  onAddCompareWinner: (item: CompareItem) => void;
  // approval-gated cart proposals
  onApproveProposal: (messageId: string, pid: string) => void;
  onDismissProposal: (messageId: string, pid: string) => void;
  onApproveAll: (messageId: string) => void;
  // "Try again" — re-run an assistant reply in place
  onRegenerate: (messageId: string) => void;
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
  onBookScenesShow?: MessageBubbleProps['onBookScenesShow'];
  // off-domain hand-off / plan step → open the owning tab with the ask
  onHandoff?: MessageBubbleProps['onHandoff'];
  onBasketAction?: MessageBubbleProps['onBasketAction'];
}

export function ChatThread({
  messages,
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
  suggestions,
  service,
  emptyBoard,
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
}: ChatThreadProps) {
  const actions = useStableActions({
    onAdd, onLoadMore, openMenu, onLoadMoreMenu, onLoadMoreDishes, addFoodItem, onPick,
    onToggleCompare, onToggleCompareFood, onAddCompareWinner, onApproveProposal,
    onDismissProposal, onApproveAll, onRegenerate, onViewDineoutSlots, onBookDineoutSlot,
    onViewScenesShows, onBookScenesShow, onHandoff, onBasketAction,
  });
  // Warm the Markdown + card chunks once the page is idle.
  useEffect(() => {
    preloadChatChunks();
  }, []);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevLenRef = useRef(messages.length);

  // Auto-scroll behavior: ALWAYS follow a brand-new turn the user just started
  // (the message array grew), but while an assistant turn streams in place keep
  // pinned to the bottom ONLY if the reader is already near it (~120px). This
  // lets the user scroll up to re-read cards mid-stream without being yanked
  // back down on every token/card update.
  useEffect(() => {
    const grew = messages.length > prevLenRef.current;
    prevLenRef.current = messages.length;
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (grew || nearBottom) {
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      bottomRef.current?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'end' });
    }
  }, [messages]);

  const last = messages[messages.length - 1];
  const lastDone = !!last && last.role === 'assistant' && !last.pending;
  // What screen readers hear when a reply settles: its opening, as plain text
  // (the per-token stream itself is never announced — far too noisy).
  const settledSummary = lastDone
    ? (() => {
        const plain = stripMarkers(last.text || '').replace(/[*_#`>|~]/g, '').replace(/\s+/g, ' ').trim();
        if (!plain) return 'Reply ready.';
        return `Reply: ${plain.length > 280 ? `${plain.slice(0, 280)}…` : plain}`;
      })()
    : '';

  if (messages.length === 0) {
    return (
      <div className="flex-1 overflow-y-auto">
        {emptyBoard ?? (
          <EmptyState onPick={onPick} suggestions={suggestions} service={service} />
        )}
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-6 sm:px-6">
      {/* role="log" keeps the conversation navigable as a log, but its implicit
          live announcements are switched off: a reply adds whole card grids
          (a dozen products read aloud) and streams token by token. The status
          region below announces "replying…" and then the settled reply text. */}
      <div
        role="log"
        aria-label="Conversation"
        aria-live="off"
        className="mx-auto flex max-w-2xl flex-col gap-6"
      >
        {messages.map((m, i) => (
          // Stable wrapper (never swapped for another element type) so a turn
          // keeps its card state when it ages out of the live tail.
          <div key={m.id} className={i < messages.length - LIVE_TAIL ? 'cv-auto' : undefined}>
            {/* One broken card can't blank the thread: only this reply shows a notice. */}
            <ErrorBoundary name="message" resetKeys={[m]}>
            <Bubble
              message={m}
              sending={sending}
              inCartQty={inCartQty}
              onAdd={actions.onAdd}
              onLoadMore={actions.onLoadMore}
              isLoadingMore={isLoadingMore}
              openMenu={actions.openMenu}
              onLoadMoreMenu={actions.onLoadMoreMenu}
              isLoadingMoreMenu={isLoadingMoreMenu}
              onLoadMoreDishes={actions.onLoadMoreDishes}
              isLoadingMoreDishes={isLoadingMoreDishes}
              addFoodItem={actions.addFoodItem}
              inFoodCartQty={inFoodCartQty}
              onPick={actions.onPick}
              isSelected={isSelected}
              onToggleCompare={actions.onToggleCompare}
              onToggleCompareFood={actions.onToggleCompareFood}
              onAddCompareWinner={actions.onAddCompareWinner}
              onApproveProposal={actions.onApproveProposal}
              onDismissProposal={actions.onDismissProposal}
              onApproveAll={actions.onApproveAll}
              onRegenerate={actions.onRegenerate}
              onViewDineoutSlots={actions.onViewDineoutSlots}
              onBookDineoutSlot={actions.onBookDineoutSlot}
              onViewScenesShows={actions.onViewScenesShows}
              onBookScenesShow={actions.onBookScenesShow}
              onHandoff={actions.onHandoff}
              onBasketAction={actions.onBasketAction}
            />
            </ErrorBoundary>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      {/* One short announcement when a reply settles (or while it's working). */}
      <p className="sr-only" role="status" aria-live="polite">
        {sending ? 'Assistant is replying…' : settledSummary}
      </p>
    </div>
  );
}

export default ChatThread;
