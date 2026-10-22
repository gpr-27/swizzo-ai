'use client';

// The streamlined, uncluttered top navigation bar:
// - Brand wordmark (Swizzo) + segmented service switcher
//   (⚡ Instamart | 🍽️ Food | 🥂 Dineout | 🎟️ Scenes | 🗺️ Plan)
// - Delivery-location pill with popover address selector
// - Actions: 🧾 History (orders page) · 💬 Chats (saved conversations) · ✨ Tools (per-service concierge hub) ·
//   account · ☀️/🌙 theme · 🛒 cart tray pill
//
// Layout (see `.topnav` in globals.css): below lg it is a 2-row grid so it
// never overflows a phone — brand | address | theme | cart on top, tabs |
// history · tools · account beneath. From lg up it is one row, in DOM order.

import type { Address, ChatSessionMeta, Service } from '@/shared/types';
import { SERVICES, SERVICE_META } from '@/shared/types';
import type { Recipe } from '@/frontend/state/recipes';
// Direct imports (not the components barrel, which re-exports this file).
import { SpikeMark } from './SpikeMark';
import { ThemeToggle } from './ThemeToggle';
import { AddressPicker } from './AddressPicker';
import { AccountMenu, type SwiggyUser } from './AccountMenu';
import { ConciergeToolsMenu } from '../features/ConciergeToolsMenu';
import { HistoryMenu } from '../features/HistoryMenu';

export interface TopNavProps {
  service: Service;
  onSelectService: (s: Service) => void;
  // History page (all past orders + bookings) — a page-level view, not a service
  historyOpen?: boolean;
  onToggleHistory?: () => void;
  addresses: Address[];
  selectedAddressId: string;
  onSelectAddress: (id: string) => void;
  onAddNewAddress?: () => void;
  onAddressDeleted?: (id: string) => void;
  cartCount: number;
  cartAmount: number; // 0 -> amount hidden
  // what the tray pill opens: "Cart" (Instamart/Food) or e.g. "Explore"
  // (Dineout/Scenes, whose tray is a prompt panel, not a cart)
  trayLabel?: string;
  onToggleTray: () => void;
  // a chat turn is streaming — gate the menus' agent-triggering actions
  sending: boolean;
  // local chat history
  history: ChatSessionMeta[];
  activeSessionId?: string; // hook.sessionId — highlights the live row
  onOpenSession: (id: string) => void;
  onNewChat: () => void;
  onDeleteSession: (id: string) => void;
  // recipe book
  recipes: Recipe[];
  onSaveRecipe: (dish: string) => void;
  onCookRecipe: (dish: string) => void; // ingredients -> cart (hook.cookRecipe)
  onCookWithMe: (dish: string) => void; // step-by-step guide (hook.cookWithMe)
  onReorderRecipe: (recipe: Recipe) => void; // rebuild cart (hook.reorderRecipe)
  onDeleteRecipe: (id: string) => void;
  // nutrition agent (Tools → Nutrition view)
  nutritionKcal: number; // running order calories for the active cart
  nutritionProtein: number; // running order protein
  onAnalyzeNutrition: () => void; // hook.nutritionReport / analyzeCart
  onAllergenSweep: () => void; // hook.allergenSweep
  onHealthierPicks: () => void; // healthier-swaps turn
  // preferences (requirement matching) + allergies + budget + macro goals
  preferences: string;
  onChangePreferences: (p: string) => void;
  allergies: string;
  onChangeAllergies: (a: string) => void;
  budget: number;
  onChangeBudget: (n: number) => void;
  kcalGoal: number;
  proteinGoal: number;
  onChangeMacroGoals: (kcal: number, protein: number) => void;
  // Tools-menu prompts (label is the short name shown in the user bubble). The
  // menu passes the service whose section the item belongs to.
  onPickTheme: (prompt: string, label: string | undefined, service: Service) => void;
  // smart deal-hunter — surfaces the heaviest offers + proposes the best to cart
  onFindDeals?: () => void;
  // smart basket — goal-driven auto-builder ("high-protein day under ₹600")
  onSmartBasket?: (goal: string) => void;
  // Swiggy authentication
  authenticated?: boolean;
  user?: SwiggyUser | null;
  authLoading?: boolean;
  onLogin?: () => void;
  onLogout?: () => Promise<void>;
}

function formatINR(n: number): string {
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

// Selected-tab accent per service. `dark:` follows html[data-theme].
const TAB_ACTIVE: Record<Service, string> = {
  instamart: 'text-amber-ink ring-amber-500/30',
  food: 'text-coral ring-coral/30',
  dineout: 'text-purple-600 dark:text-purple-300 ring-purple-500/30',
  scenes: 'text-cyan-700 dark:text-cyan-300 ring-cyan-500/30',
  plan: 'text-emerald-700 dark:text-emerald-300 ring-emerald-500/30',
};

export function TopNav({
  service,
  onSelectService,
  historyOpen = false,
  onToggleHistory,
  addresses,
  selectedAddressId,
  onSelectAddress,
  onAddNewAddress,
  onAddressDeleted,
  cartCount,
  cartAmount,
  trayLabel = 'Cart',
  onToggleTray,
  sending,
  history,
  activeSessionId,
  onOpenSession,
  onNewChat,
  onDeleteSession,
  recipes,
  onSaveRecipe,
  onCookRecipe,
  onCookWithMe,
  onReorderRecipe,
  onDeleteRecipe,
  nutritionKcal,
  nutritionProtein,
  onAnalyzeNutrition,
  onAllergenSweep,
  onHealthierPicks,
  preferences,
  onChangePreferences,
  allergies,
  onChangeAllergies,
  budget,
  onChangeBudget,
  kcalGoal,
  proteinGoal,
  onChangeMacroGoals,
  onPickTheme,
  onFindDeals,
  onSmartBasket,
  authenticated = true,
  user = null,
  authLoading = false,
  onLogin = () => {},
  onLogout = async () => {},
}: TopNavProps) {
  // Roving-focus tablist: ←/→/Home/End move between services (WAI-ARIA tabs).
  const onTabKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const idx = SERVICES.indexOf(service);
    let next = -1;
    if (e.key === 'ArrowRight') next = (idx + 1) % SERVICES.length;
    else if (e.key === 'ArrowLeft') next = (idx - 1 + SERVICES.length) % SERVICES.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = SERVICES.length - 1;
    if (next < 0) return;
    e.preventDefault();
    onSelectService(SERVICES[next]);
    e.currentTarget
      .querySelectorAll<HTMLButtonElement>('[role="tab"]')
      [next]?.focus();
  };

  const isCart = trayLabel === 'Cart';

  return (
    <header className="sticky top-0 z-30 border-b border-hairline/80 bg-canvas/80 backdrop-blur-xl transition-all duration-300">
      <div className="topnav mx-auto max-w-[1480px] px-4 sm:px-6">
        {/* Brand */}
        <div className="topnav-brand flex shrink-0 items-center gap-2.5">
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-dark text-on-dark shadow-sm ring-1 ring-hairline">
            <SpikeMark className="h-4 w-4" />
          </span>
          <span className="hidden items-baseline font-display text-xl font-bold tracking-tight text-ink sm:flex">
            Swizzo
            <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-coral motion-safe:animate-pulse" aria-hidden="true" />
          </span>
        </div>

        {/* Segmented service switcher — 4 services + the Plan tab */}
        <div
          role="tablist"
          aria-label="Service"
          onKeyDown={onTabKey}
          className="topnav-tabs flex min-w-0 max-w-full items-center gap-1 justify-self-start overflow-x-auto lg:shrink-0 rounded-full border border-hairline/90 bg-surface-soft/80 p-1 shadow-inner backdrop-blur-sm"
        >
          {SERVICES.map((s) => {
            const meta = SERVICE_META[s];
            // While History is open no service tab reads as selected.
            const active = service === s && !historyOpen;
            return (
              <button
                key={s}
                type="button"
                role="tab"
                aria-selected={active}
                tabIndex={service === s ? 0 : -1}
                title={`${meta.label} — ${meta.tagline}`}
                onClick={() => onSelectService(s)}
                className={`flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition-all ${
                  active
                    ? `bg-canvas shadow-sm ring-1 ${TAB_ACTIVE[s]}`
                    : 'text-muted hover:bg-canvas/50 hover:text-ink'
                }`}
              >
                <span className="text-xs" aria-hidden="true">
                  {meta.emoji}
                </span>
                {/* Icon-only until xl, but always named for assistive tech. */}
                <span className="topnav-tab-label sr-only xl:not-sr-only">{meta.label}</span>
              </button>
            );
          })}
        </div>

        {/* Delivery location pill */}
        <div className="topnav-addr flex items-center lg:mx-auto">
          <AddressPicker
            addresses={addresses}
            selectedAddressId={selectedAddressId}
            onSelectAddress={onSelectAddress}
            onAddNewAddress={onAddNewAddress}
            onAddressDeleted={onAddressDeleted}
          />
        </div>

        {/* Actions */}
        <div className="topnav-actions flex items-center gap-2">
          {/* 0. History page: every past order (Food, Instamart, Dineout, Scenes) */}
          {onToggleHistory && (
            <button
              type="button"
              onClick={onToggleHistory}
              aria-pressed={historyOpen}
              aria-label={historyOpen ? 'Close order history' : 'Order history'}
              title="Your orders — Food, Instamart, Dineout, Scenes"
              className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-2 text-xs font-semibold shadow-xs transition-colors ${
                historyOpen
                  ? 'border-coral bg-coral text-on-primary hover:bg-coral-active'
                  : 'border-hairline bg-surface-card/60 text-body hover:border-coral/50 hover:bg-surface-card hover:text-ink'
              }`}
            >
              <svg
                viewBox="0 0 24 24"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" />
                <path d="M9 8h6M9 12h6M9 16h3" />
              </svg>
              <span className="hidden sm:inline lg:hidden 2xl:inline">History</span>
            </button>
          )}

          {/* 1. Chats & History */}
          <HistoryMenu
            history={history}
            activeId={activeSessionId}
            onOpen={onOpenSession}
            onNew={onNewChat}
            onDelete={onDeleteSession}
          />

          {/* 2. Per-service Concierge Tools hub */}
          <ConciergeToolsMenu
            service={service}
            sending={sending}
            onFindDeals={onFindDeals}
            nutritionKcal={nutritionKcal}
            nutritionProtein={nutritionProtein}
            kcalGoal={kcalGoal}
            proteinGoal={proteinGoal}
            onChangeMacroGoals={onChangeMacroGoals}
            hasItems={cartCount > 0}
            onAnalyzeNutrition={onAnalyzeNutrition}
            onAllergenSweep={onAllergenSweep}
            onHealthierPicks={onHealthierPicks}
            preferences={preferences}
            onChangePreferences={onChangePreferences}
            allergies={allergies}
            onChangeAllergies={onChangeAllergies}
            budget={budget}
            onChangeBudget={onChangeBudget}
            recipes={recipes}
            onSaveRecipe={onSaveRecipe}
            onCookRecipe={onCookRecipe}
            onCookWithMe={onCookWithMe}
            onReorderRecipe={onReorderRecipe}
            onDeleteRecipe={onDeleteRecipe}
            onPickTheme={onPickTheme}
            onSmartBasket={onSmartBasket}
          />

          {/* 3. Account / Login */}
          <AccountMenu
            authenticated={Boolean(authenticated)}
            user={user}
            loading={authLoading}
            onLogin={onLogin}
            onLogout={onLogout}
          />

        </div>

        {/* 4. Theme Toggle (row 1 on phones, beside the cart) */}
        <div className="topnav-theme flex items-center">
          <ThemeToggle />
        </div>

        {/* 5. Cart / tray pill */}
        <button
          type="button"
          onClick={onToggleTray}
          aria-label={
            isCart
              ? cartCount > 0
                ? `View cart: ${cartCount} ${cartCount === 1 ? 'item' : 'items'}${cartAmount > 0 ? `, ${formatINR(cartAmount)}` : ''}`
                : 'View cart (empty)'
              : `Open ${trayLabel} panel`
          }
          className={`topnav-cart group inline-flex shrink-0 items-center gap-2.5 rounded-full border px-3.5 py-2 text-xs font-semibold shadow-sm transition-all duration-200 lg:px-4 ${
            cartCount > 0
              ? 'border-coral/40 bg-coral/[0.08] text-coral hover:border-coral hover:bg-coral/[0.14]'
              : 'border-hairline bg-surface-card/60 text-body hover:border-coral/50 hover:bg-surface-card hover:text-ink'
          }`}
        >
          <span className="relative inline-flex items-center justify-center">
            {isCart ? (
              <svg
                viewBox="0 0 24 24"
                className={`h-4 w-4 transition-transform group-hover:scale-110 ${cartCount > 0 ? 'text-coral' : 'text-ink'}`}
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="9" cy="20" r="1.5" />
                <circle cx="18" cy="20" r="1.5" />
                <path d="M2.5 3.5h2l2.2 11.2a1.5 1.5 0 0 0 1.5 1.2h8.4a1.5 1.5 0 0 0 1.5-1.2L21 7H6" />
              </svg>
            ) : (
              <svg
                viewBox="0 0 24 24"
                className="h-4 w-4 text-ink transition-transform group-hover:scale-110"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M4 5h16M4 12h16M4 19h10" />
              </svg>
            )}
            {cartCount > 0 && (
              <span
                className="absolute -right-2.5 -top-2 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-coral px-1 text-[10px] font-bold leading-none text-on-primary shadow-xs"
                aria-hidden="true"
              >
                {cartCount}
              </span>
            )}
          </span>
          {cartAmount > 0 ? (
            <span className="font-display text-xs font-bold text-ink">
              {formatINR(cartAmount)}
            </span>
          ) : (
            <span className="hidden text-xs text-muted sm:inline">{trayLabel}</span>
          )}
        </button>
      </div>
    </header>
  );
}

export default TopNav;
