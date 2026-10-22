'use client';

// ConciergeToolsMenu — The unified master intelligence hub for Swizzo.
// Consolidates Deals, Nutrition (+ daily goals), Diet Preferences, Smart Basket,
// Recipe Book (cook / step timer / one-tap reorder) and Themes into one clean
// popover, with a per-service hub. Every hub prompt is sent to the service whose
// section it lives in (never forced onto Instamart).

import { useEffect, useRef, useState } from 'react';
import type { Recipe } from '@/frontend/state/recipes';
import { STARTER_RECIPES } from '@/frontend/state/recipes';
import type { Service } from '@/shared/types';
// Direct import (not the components barrel, which re-exports this file).
import { MacroMeter } from '../cart/MacroMeter';

export interface ConciergeToolsMenuProps {
  service: Service;
  sending?: boolean;
  // Deals
  onFindDeals?: () => void;
  // Nutrition
  nutritionKcal: number;
  nutritionProtein: number;
  kcalGoal: number;
  proteinGoal: number;
  onChangeMacroGoals: (kcal: number, protein: number) => void;
  hasItems: boolean;
  onAnalyzeNutrition: () => void;
  onAllergenSweep: () => void;
  onHealthierPicks: () => void;
  // Diet & Preferences
  preferences: string;
  onChangePreferences: (p: string) => void;
  allergies: string;
  onChangeAllergies: (a: string) => void;
  budget: number;
  onChangeBudget: (n: number) => void;
  // Recipes
  recipes: Recipe[];
  onSaveRecipe: (dish: string) => void;
  onCookRecipe: (dish: string) => void;
  onCookWithMe: (dish: string) => void;
  // rebuild the cart from the recipe's saved items (falls back to a cook run)
  onReorderRecipe?: (recipe: Recipe) => void;
  onDeleteRecipe: (id: string) => void;
  // Hub prompts / Themes / Occasions — routed to `service` (the section's tab)
  onPickTheme: (prompt: string, label: string | undefined, service: Service) => void;
  // Smart Basket
  onSmartBasket?: (goal: string) => void;
}

type ToolView = 'hub' | 'nutrition' | 'preferences' | 'recipes' | 'smart_basket' | 'themes';

const ALLERGENS = [
  'Peanuts',
  'Tree nuts',
  'Gluten',
  'Lactose',
  'Soy',
  'Eggs',
  'Shellfish',
];

const QUICK_DIETS = [
  'High protein',
  'Vegetarian',
  'Low sugar',
  'Low fat',
  'High fibre',
  'No palm oil',
  'Budget-friendly',
  'Keto',
];

const THEMES = [
  {
    emoji: '🍿',
    title: 'Movie night',
    subtitle: 'Nachos, popcorn & cold drink',
    prompt:
      'Build a movie-night basket — nachos, a dip, popcorn, chocolate and a cold drink. Search each so I can add them, and mark the best pick of each.',
  },
  {
    emoji: '💕',
    title: 'Date night in',
    subtitle: 'A cozy recipe + the groceries',
    prompt:
      'Plan a cozy date-night dinner I can cook tonight — a simple romantic recipe. List the ingredients, then show product picks for each.',
  },
  {
    emoji: '💪',
    title: 'Post-workout',
    subtitle: 'High-protein picks, ranked',
    prompt:
      'Show me high-protein post-workout snacks and drinks, and recommend the best.',
  },
  {
    emoji: '🌧️',
    title: 'Rainy day',
    subtitle: 'Cozy snacks & something hot',
    prompt:
      'Rainy-day comfort cravings — search a few cozy snacks and a hot option.',
  },
  {
    emoji: '🎉',
    title: 'Party for 8',
    subtitle: 'Snacks & drinks to add fast',
    prompt:
      'Plan party snacks and drinks for 8 people — search each item so I can add them.',
  },
];

// Plan tab templates — each one asks the planner for a full multi-service outing.
const PLAN_PRESETS = [
  {
    emoji: '👨‍👩‍👧‍👦',
    title: 'Family day at the mall',
    subtitle: 'Mall, a show, dinner out, snacks home',
    prompt:
      'Plan a family outing for 2 adults and 2 kids this Saturday from 4 PM: time at a mall near me, then a show, dinner out, and snacks for the ride home. Budget about ₹5000, veg-friendly.',
  },
  {
    emoji: '💕',
    title: 'Date night',
    subtitle: 'A live show + a romantic table',
    prompt: 'Plan a date night for two tonight from 7 PM — a live show and a romantic dinner nearby, under ₹3000.',
  },
  {
    emoji: '🎤',
    title: 'Comedy night with friends',
    subtitle: 'Standup + a lively dinner spot',
    prompt: 'Plan a night out for 4 friends this Friday: a standup comedy show, then dinner at a lively place. About ₹1500 each.',
  },
  {
    emoji: '🍿',
    title: 'Movie night in',
    subtitle: 'Dinner delivered + snacks & drinks',
    prompt: 'Plan a movie night at home for 3 this evening: dinner delivered and snacks & drinks from Instamart, around ₹1200.',
  },
];

const BASKET_PRESETS = [
  { emoji: '💪', label: 'High-protein day under ₹600' },
  { emoji: '🥗', label: 'Light, healthy dinner for two' },
  { emoji: '🍳', label: 'A week of breakfasts under ₹500' },
  { emoji: '🌱', label: 'Vegan staples for the week' },
  { emoji: '💸', label: 'Budget essentials under ₹400' },
];

export function ConciergeToolsMenu({
  service,
  sending,
  onFindDeals,
  nutritionKcal,
  nutritionProtein,
  kcalGoal,
  proteinGoal,
  onChangeMacroGoals,
  hasItems,
  onAnalyzeNutrition,
  onAllergenSweep,
  onHealthierPicks,
  preferences,
  onChangePreferences,
  allergies,
  onChangeAllergies,
  budget,
  onChangeBudget,
  recipes,
  onSaveRecipe,
  onCookRecipe,
  onCookWithMe,
  onReorderRecipe,
  onDeleteRecipe,
  onPickTheme,
  onSmartBasket,
}: ConciergeToolsMenuProps) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<ToolView>('hub');
  const [customBasketGoal, setCustomBasketGoal] = useState('');
  const [newRecipeDish, setNewRecipeDish] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Open always lands on the hub — reset here in the handler (no effect).
  const toggleOpen = () => {
    if (!open) setView('hub');
    setOpen(!open);
  };

  // Send a hub prompt to THIS section's service, then close the menu.
  const pickTheme = (prompt: string, label?: string) => {
    onPickTheme(prompt, label, service);
  };

  // Close on outside pointer / Escape (focus returns to the trigger), and move
  // focus into the panel when it opens.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    panelRef.current?.querySelector<HTMLElement>('button, input')?.focus();
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Preferences / allergies are comma-separated free text; match whole tokens
  // (so "Vegetarian" isn't "on" for "Non-vegetarian", nor "Soy" for "Soya").
  const tokens = (csv: string) =>
    csv
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
  const hasAllergen = (chip: string) =>
    tokens(allergies).includes(chip.toLowerCase());
  const toggleAllergen = (chip: string) => {
    if (hasAllergen(chip)) {
      onChangeAllergies(
        allergies
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.toLowerCase() !== chip.toLowerCase())
          .join(', '),
      );
    } else {
      const next = allergies.trim() ? `${allergies.trim()}, ${chip}` : chip;
      onChangeAllergies(next);
    }
  };

  const hasPreference = (chip: string) =>
    tokens(preferences).includes(chip.toLowerCase());
  const togglePreference = (chip: string) => {
    if (hasPreference(chip)) {
      onChangePreferences(
        preferences
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.toLowerCase() !== chip.toLowerCase())
          .join(', '),
      );
    } else {
      const next = preferences.trim() ? `${preferences.trim()}, ${chip}` : chip;
      onChangePreferences(next);
    }
  };

  // Active badges summary
  const hasActivePrefs = Boolean(preferences || allergies || budget > 0);
  const hasActiveMacros = nutritionKcal > 0 || nutritionProtein > 0;

  return (
    <div ref={ref} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={toggleOpen}
        aria-label="Concierge Tools"
        aria-expanded={open}
        aria-haspopup="dialog"
        className={`group flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-all ${
          open
            ? 'border-coral/70 bg-surface-card text-ink shadow-xs'
            : 'border-hairline bg-surface-card/40 text-body hover:border-coral/40 hover:bg-surface-card/80 hover:text-ink'
        }`}
      >
        <span className="text-sm" aria-hidden="true">✨</span>
        <span className="hidden font-medium sm:inline lg:hidden 2xl:inline">Tools</span>
        <svg
          viewBox="0 0 24 24"
          className={`h-3.5 w-3.5 text-muted transition-transform duration-200 ${
            open ? 'rotate-180 text-coral' : 'group-hover:text-ink'
          }`}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open && (
        // Below lg: a sheet pinned under the 2-row header (an anchored right-0
        // panel would hang off the left edge of a phone). lg+: anchored dropdown.
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Concierge tools"
          className="fixed inset-x-3 top-[calc(var(--nav-h)+0.25rem)] z-40 overflow-hidden rounded-2xl border border-hairline bg-canvas shadow-card animate-rise sm:left-auto sm:right-4 sm:w-[420px] lg:absolute lg:right-0 lg:top-11"
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-hairline bg-surface-card/30 px-4 py-3">
            {view === 'hub' ? (
              <div>
                <div className="flex items-center gap-1.5">
                  <span className="font-display text-sm font-semibold text-ink">
                    {service === 'instamart' && 'Instamart Concierge Tools'}
                    {service === 'food' && 'Food Concierge Tools'}
                    {service === 'dineout' && 'Dineout Concierge Tools'}
                    {service === 'scenes' && 'Scenes Box Office Tools'}
                    {service === 'plan' && 'Outing Planner Tools'}
                  </span>
                  <span className={`rounded-full px-1.5 py-px text-[9px] font-bold uppercase tracking-wider ${
                    service === 'instamart' ? 'bg-amber-500/15 text-amber-800 dark:text-amber-400' :
                    service === 'food' ? 'bg-orange-500/15 text-orange-700 dark:text-orange-400' :
                    service === 'dineout' ? 'bg-purple-500/15 text-purple-600 dark:text-purple-400' :
                    service === 'plan' ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400' :
                    'bg-cyan-500/15 text-cyan-700 dark:text-cyan-400'
                  }`}>
                    {service}
                  </span>
                </div>
                <p className="text-[11px] text-muted">
                  {service === 'instamart' && 'Smart grocery planning, macros & recipes'}
                  {service === 'food' && 'Coupons, gourmet picks, macros & bill split'}
                  {service === 'dineout' && 'Table reservations, microbreweries & bill offers'}
                  {service === 'scenes' && 'Live concerts, comedy, theatre & ticket passes'}
                  {service === 'plan' && 'Show + table + dinner home + snacks, as one plan'}
                </p>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setView('hub')}
                className="inline-flex items-center gap-1 text-xs font-medium text-coral transition-colors hover:text-coral-active"
              >
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
                  <path d="m15 18-6-6 6-6" />
                </svg>
                Back to Tools
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                triggerRef.current?.focus();
              }}
              className="rounded-full p-1 text-muted-soft transition-colors hover:bg-surface-card hover:text-ink"
              aria-label="Close menu"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Body Container */}
          <div className="max-h-[min(75vh,calc(100dvh-var(--nav-h)-5rem))] overflow-y-auto p-3">
            {/* ────────────────── HUB VIEW ────────────────── */}
            {view === 'hub' && (
              <div className="space-y-2">
                {/* 1. INSTAMART VERTICAL TOOLS */}
                {service === 'instamart' && (
                  <>
                    {onFindDeals && (
                      <button
                        type="button"
                        onClick={() => {
                          onFindDeals();
                          setOpen(false);
                        }}
                        disabled={sending}
                        className="group relative flex w-full items-center justify-between rounded-xl border border-coral/30 bg-gradient-to-r from-coral/10 via-coral/5 to-transparent p-3 text-left transition-all hover:border-coral hover:shadow-xs disabled:opacity-50"
                      >
                        <div className="flex items-center gap-3">
                          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-coral text-lg text-on-primary shadow-xs">
                            🏷️
                          </span>
                          <div>
                            <div className="flex items-center gap-1.5">
                              <span className="text-xs font-semibold text-ink group-hover:text-coral">
                                Today&apos;s Heaviest Deals
                              </span>
                              <span className="rounded-full bg-coral px-1.5 py-px text-[9px] font-bold text-on-primary">
                                SAVE
                              </span>
                            </div>
                            <p className="text-[11px] text-muted">
                              Search price drops & auto-propose biggest savers
                            </p>
                          </div>
                        </div>
                        <span className="text-xs font-medium text-coral">Explore →</span>
                      </button>
                    )}

                    <div className="grid gap-1.5 pt-1">
                      <button
                        type="button"
                        onClick={() => setView('smart_basket')}
                        className="group flex w-full items-center justify-between rounded-xl border border-hairline bg-surface-card/20 p-2.5 text-left transition-all hover:border-coral/40 hover:bg-surface-card/60"
                      >
                        <div className="flex items-center gap-2.5">
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-card text-base">
                            🛒
                          </span>
                          <div>
                            <span className="text-xs font-medium text-ink">Smart Basket Builder</span>
                            <p className="text-[11px] text-muted">
                              Auto-plan cart: &ldquo;High-protein day under ₹600&rdquo;
                            </p>
                          </div>
                        </div>
                        <span className="text-muted-soft group-hover:text-ink">›</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => setView('recipes')}
                        className="group flex w-full items-center justify-between rounded-xl border border-hairline bg-surface-card/20 p-2.5 text-left transition-all hover:border-coral/40 hover:bg-surface-card/60"
                      >
                        <div className="flex items-center gap-2.5">
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-card text-base">
                            📖
                          </span>
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-medium text-ink">Recipe Book & Cook Mode</span>
                              {recipes.length > 0 && (
                                <span className="rounded-full bg-surface-card px-1.5 py-px text-[10px] text-muted">
                                  {recipes.length}
                                </span>
                              )}
                            </div>
                            <p className="text-[11px] text-muted">
                              Saved dishes, ingredient carts & step timer
                            </p>
                          </div>
                        </div>
                        <span className="text-muted-soft group-hover:text-ink">›</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => setView('nutrition')}
                        className="group flex w-full items-center justify-between rounded-xl border border-hairline bg-surface-card/20 p-2.5 text-left transition-all hover:border-coral/40 hover:bg-surface-card/60"
                      >
                        <div className="flex items-center gap-2.5">
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-card text-base">
                            🥗
                          </span>
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-medium text-ink">Nutrition & Macros</span>
                              {hasActiveMacros && (
                                <span className="rounded-full bg-success/15 px-1.5 py-px text-[10px] font-medium text-success-ink">
                                  {nutritionKcal} kcal
                                </span>
                              )}
                            </div>
                            <p className="text-[11px] text-muted">
                              Calorie meter, cart audit & allergen scan
                            </p>
                          </div>
                        </div>
                        <span className="text-muted-soft group-hover:text-ink">›</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => setView('preferences')}
                        className="group flex w-full items-center justify-between rounded-xl border border-hairline bg-surface-card/20 p-2.5 text-left transition-all hover:border-coral/40 hover:bg-surface-card/60"
                      >
                        <div className="flex items-center gap-2.5">
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-card text-base">
                            🎯
                          </span>
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-medium text-ink">Diet & Budget Goals</span>
                              {hasActivePrefs && (
                                <span className="rounded-full bg-coral/15 px-1.5 py-px text-[10px] font-medium text-coral">
                                  Active
                                </span>
                              )}
                            </div>
                            <p className="text-[11px] text-muted">
                              Vegetarian, keto, allergens & budget ceiling
                            </p>
                          </div>
                        </div>
                        <span className="text-muted-soft group-hover:text-ink">›</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => setView('themes')}
                        className="group flex w-full items-center justify-between rounded-xl border border-hairline bg-surface-card/20 p-2.5 text-left transition-all hover:border-coral/40 hover:bg-surface-card/60"
                      >
                        <div className="flex items-center gap-2.5">
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-card text-base">
                            🍿
                          </span>
                          <div>
                            <span className="text-xs font-medium text-ink">Inspiration & Occasions</span>
                            <p className="text-[11px] text-muted">
                              Movie night, date night & party planning
                            </p>
                          </div>
                        </div>
                        <span className="text-muted-soft group-hover:text-ink">›</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          pickTheme('Restock everyday staples: fresh milk, farm eggs, whole wheat bread and curd.', 'Morning Staples');
                          setOpen(false);
                        }}
                        className="group flex w-full items-center justify-between rounded-xl border border-dashed border-amber-500/40 bg-amber-500/5 p-2.5 text-left transition-all hover:border-amber-500 hover:bg-amber-500/10"
                      >
                        <div className="flex items-center gap-2.5">
                          <span className="text-base">⚡</span>
                          <div>
                            <span className="text-xs font-semibold text-ink">Quick Staples Restock</span>
                            <p className="text-[11px] text-muted">Find milk, eggs, bread & curd in one go</p>
                          </div>
                        </div>
                        <span className="text-xs font-bold text-amber-ink">→</span>
                      </button>
                    </div>
                  </>
                )}

                {/* 2. FOOD VERTICAL TOOLS */}
                {service === 'food' && (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        pickTheme("Find restaurants near me with active offers, and tell me which coupons apply", "Best Food Coupons");
                        setOpen(false);
                      }}
                      className="group relative flex w-full items-center justify-between rounded-xl border border-orange-500/30 bg-gradient-to-r from-orange-500/10 via-orange-500/5 to-transparent p-3 text-left transition-all hover:border-orange-500 hover:shadow-xs"
                    >
                      <div className="flex items-center gap-3">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-orange-500 text-lg text-white shadow-xs">
                          🔥
                        </span>
                        <div>
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs font-semibold text-ink group-hover:text-orange-500">
                              Best Offer & Coupon Hunter
                            </span>
                            <span className="rounded-full bg-orange-500 px-1.5 py-px text-[9px] font-bold text-white">
                              OFFERS
                            </span>
                          </div>
                          <p className="text-[11px] text-muted">
                            Restaurants with live offers & the coupons that apply
                          </p>
                        </div>
                      </div>
                      <span className="text-xs font-medium text-orange-700">Hunt →</span>
                    </button>

                    <div className="grid gap-1.5 pt-1">
                      <button
                        type="button"
                        onClick={() => {
                          pickTheme("Show top-rated restaurants near me (4.5 stars and above) and their bestseller dishes", "4.5★ Gourmet");
                          setOpen(false);
                        }}
                        className="group flex w-full items-center justify-between rounded-xl border border-hairline bg-surface-card/20 p-2.5 text-left transition-all hover:border-orange-500/40 hover:bg-surface-card/60"
                      >
                        <div className="flex items-center gap-2.5">
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-card text-base">
                            ⭐
                          </span>
                          <div>
                            <span className="text-xs font-medium text-ink">4.5+ Gourmet & Hidden Gems</span>
                            <p className="text-[11px] text-muted">
                              Highest-rated kitchens near you & their bestsellers
                            </p>
                          </div>
                        </div>
                        <span className="text-muted-soft group-hover:text-ink">›</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => setView('nutrition')}
                        className="group flex w-full items-center justify-between rounded-xl border border-hairline bg-surface-card/20 p-2.5 text-left transition-all hover:border-orange-500/40 hover:bg-surface-card/60"
                      >
                        <div className="flex items-center gap-2.5">
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-card text-base">
                            🥗
                          </span>
                          <div>
                            <span className="text-xs font-medium text-ink">Healthier Swaps & Macro Goals</span>
                            <p className="text-[11px] text-muted">
                              Calorie meter, protein tracker & low-carb alternatives
                            </p>
                          </div>
                        </div>
                        <span className="text-muted-soft group-hover:text-ink">›</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          pickTheme("Show the best restaurants open right now for late night delivery", "Late Night Bites");
                          setOpen(false);
                        }}
                        className="group flex w-full items-center justify-between rounded-xl border border-hairline bg-surface-card/20 p-2.5 text-left transition-all hover:border-orange-500/40 hover:bg-surface-card/60"
                      >
                        <div className="flex items-center gap-2.5">
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-card text-base">
                            🌙
                          </span>
                          <div>
                            <span className="text-xs font-medium text-ink">Late Night Cravings</span>
                            <p className="text-[11px] text-muted">
                              Restaurants that are open and delivering right now
                            </p>
                          </div>
                        </div>
                        <span className="text-muted-soft group-hover:text-ink">›</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          pickTheme("Help me plan a group dinner for 4 people with diverse starters and mains, and calculate the per-person split", "Group Order Split");
                          setOpen(false);
                        }}
                        className="group flex w-full items-center justify-between rounded-xl border border-hairline bg-surface-card/20 p-2.5 text-left transition-all hover:border-orange-500/40 hover:bg-surface-card/60"
                      >
                        <div className="flex items-center gap-2.5">
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-card text-base">
                            👥
                          </span>
                          <div>
                            <span className="text-xs font-medium text-ink">Group Order & Bill Splitter</span>
                            <p className="text-[11px] text-muted">
                              Plan multi-item order & calculate per-person split
                            </p>
                          </div>
                        </div>
                        <span className="text-muted-soft group-hover:text-ink">›</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => setView('preferences')}
                        className="group flex w-full items-center justify-between rounded-xl border border-hairline bg-surface-card/20 p-2.5 text-left transition-all hover:border-orange-500/40 hover:bg-surface-card/60"
                      >
                        <div className="flex items-center gap-2.5">
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-card text-base">
                            🌶️
                          </span>
                          <div>
                            <span className="text-xs font-medium text-ink">Diet & Spice Preferences</span>
                            <p className="text-[11px] text-muted">
                              Vegetarian, high-protein, low-sugar & allergen filters
                            </p>
                          </div>
                        </div>
                        <span className="text-muted-soft group-hover:text-ink">›</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          pickTheme("Show top-rated food spots near me with fast delivery under 30 minutes", "Lightning 30m");
                          setOpen(false);
                        }}
                        className="group flex w-full items-center justify-between rounded-xl border border-dashed border-orange-500/40 bg-orange-500/5 p-2.5 text-left transition-all hover:border-orange-500 hover:bg-orange-500/10"
                      >
                        <div className="flex items-center gap-2.5">
                          <span className="text-base">⚡</span>
                          <div>
                            <span className="text-xs font-semibold text-ink">Lightning Fast (Under 30m)</span>
                            <p className="text-[11px] text-muted">Well-rated places with the shortest delivery times</p>
                          </div>
                        </div>
                        <span className="text-xs font-bold text-orange-700">→</span>
                      </button>
                    </div>
                  </>
                )}

                {/* 3. DINEOUT VERTICAL TOOLS */}
                {service === 'dineout' && (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        pickTheme("Find restaurants near me with the best table-booking offers right now", "Dineout Offers");
                        setOpen(false);
                      }}
                      className="group relative flex w-full items-center justify-between rounded-xl border border-purple-500/30 bg-gradient-to-r from-purple-500/10 via-purple-500/5 to-transparent p-3 text-left transition-all hover:border-purple-500 hover:shadow-xs"
                    >
                      <div className="flex items-center gap-3">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-purple-500 text-lg text-white shadow-xs">
                          🥂
                        </span>
                        <div>
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs font-semibold text-ink group-hover:text-purple-500">
                              Best Table Offers
                            </span>
                            <span className="rounded-full bg-purple-500 px-1.5 py-px text-[9px] font-bold text-white">
                              DEALS
                            </span>
                          </div>
                          <p className="text-[11px] text-muted">
                            Live deals Swiggy Dineout shows for tables near you
                          </p>
                        </div>
                      </div>
                      <span className="text-xs font-medium text-purple-700">View Offers →</span>
                    </button>

                    <div className="grid gap-1.5 pt-1">
                      <button
                        type="button"
                        onClick={() => {
                          pickTheme("I want to reserve a table for dinner tonight for 2 guests around 8 PM", "Reserve a Table");
                          setOpen(false);
                        }}
                        className="group flex w-full items-center justify-between rounded-xl border border-hairline bg-surface-card/20 p-2.5 text-left transition-all hover:border-purple-500/40 hover:bg-surface-card/60"
                      >
                        <div className="flex items-center gap-2.5">
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-card text-base">
                            📅
                          </span>
                          <div>
                            <span className="text-xs font-medium text-ink">Instant Table Reservation</span>
                            <p className="text-[11px] text-muted">
                              Book dinner or lunch slot with instant confirmation
                            </p>
                          </div>
                        </div>
                        <span className="text-muted-soft group-hover:text-ink">›</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          pickTheme("Find popular microbreweries and brewpubs near me", "Craft Microbreweries");
                          setOpen(false);
                        }}
                        className="group flex w-full items-center justify-between rounded-xl border border-hairline bg-surface-card/20 p-2.5 text-left transition-all hover:border-purple-500/40 hover:bg-surface-card/60"
                      >
                        <div className="flex items-center gap-2.5">
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-card text-base">
                            🍻
                          </span>
                          <div>
                            <span className="text-xs font-medium text-ink">Microbreweries & Craft Beer Taps</span>
                            <p className="text-[11px] text-muted">
                              Brewpubs and taprooms near you
                            </p>
                          </div>
                        </div>
                        <span className="text-muted-soft group-hover:text-ink">›</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          pickTheme("Show restaurants near me with weekend lunch or dinner buffets", "Weekend Buffets");
                          setOpen(false);
                        }}
                        className="group flex w-full items-center justify-between rounded-xl border border-hairline bg-surface-card/20 p-2.5 text-left transition-all hover:border-purple-500/40 hover:bg-surface-card/60"
                      >
                        <div className="flex items-center gap-2.5">
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-card text-base">
                            🍽️
                          </span>
                          <div>
                            <span className="text-xs font-medium text-ink">Weekend Buffet Passes</span>
                            <p className="text-[11px] text-muted">
                              Restaurants offering buffets this weekend
                            </p>
                          </div>
                        </div>
                        <span className="text-muted-soft group-hover:text-ink">›</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          pickTheme("Show romantic rooftop restaurants with great ambiance, candlelight, and city skyline views", "Romantic Rooftops");
                          setOpen(false);
                        }}
                        className="group flex w-full items-center justify-between rounded-xl border border-hairline bg-surface-card/20 p-2.5 text-left transition-all hover:border-purple-500/40 hover:bg-surface-card/60"
                      >
                        <div className="flex items-center gap-2.5">
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-card text-base">
                            🌹
                          </span>
                          <div>
                            <span className="text-xs font-medium text-ink">Romantic Rooftops & Candlelight</span>
                            <p className="text-[11px] text-muted">
                              Intimate date nights, skyline terraces & fine dining
                            </p>
                          </div>
                        </div>
                        <span className="text-muted-soft group-hover:text-ink">›</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          pickTheme("Find venues suitable for a large group of 8+ people with private dining or set menus", "Corporate & Groups");
                          setOpen(false);
                        }}
                        className="group flex w-full items-center justify-between rounded-xl border border-hairline bg-surface-card/20 p-2.5 text-left transition-all hover:border-purple-500/40 hover:bg-surface-card/60"
                      >
                        <div className="flex items-center gap-2.5">
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-card text-base">
                            👔
                          </span>
                          <div>
                            <span className="text-xs font-medium text-ink">Large Group & Corporate Dining</span>
                            <p className="text-[11px] text-muted">
                              Private dining halls & tailored group packages
                            </p>
                          </div>
                        </div>
                        <span className="text-muted-soft group-hover:text-ink">›</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          pickTheme("Find lively cocktail lounges and bars with 1+1 drinks or active happy hours", "Happy Hours");
                          setOpen(false);
                        }}
                        className="group flex w-full items-center justify-between rounded-xl border border-dashed border-purple-500/40 bg-purple-500/5 p-2.5 text-left transition-all hover:border-purple-500 hover:bg-purple-500/10"
                      >
                        <div className="flex items-center gap-2.5">
                          <span className="text-base">🍸</span>
                          <div>
                            <span className="text-xs font-semibold text-ink">1+1 Happy Hours & Cocktails</span>
                            <p className="text-[11px] text-muted">Bars & lounges with drinks offers</p>
                          </div>
                        </div>
                        <span className="text-xs font-bold text-purple-600">→</span>
                      </button>
                    </div>
                  </>
                )}

                {/* 4. SCENES VERTICAL TOOLS */}
                {service === 'scenes' && (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        pickTheme("Show trending events near me with their ticket prices", "Trending Events");
                        setOpen(false);
                      }}
                      className="group relative flex w-full items-center justify-between rounded-xl border border-cyan-500/30 bg-gradient-to-r from-cyan-500/10 via-cyan-500/5 to-transparent p-3 text-left transition-all hover:border-cyan-500 hover:shadow-xs"
                    >
                      <div className="flex items-center gap-3">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-cyan-500 text-lg text-white shadow-xs">
                          🎟️
                        </span>
                        <div>
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs font-semibold text-ink group-hover:text-cyan-500">
                              Trending Events
                            </span>
                            <span className="rounded-full bg-cyan-500 px-1.5 py-px text-[9px] font-bold text-white">
                              LIVE
                            </span>
                          </div>
                          <p className="text-[11px] text-muted">
                            What&apos;s popular near you, with ticket prices
                          </p>
                        </div>
                      </div>
                      <span className="text-xs font-medium text-cyan-700">Explore →</span>
                    </button>

                    <div className="grid gap-1.5 pt-1">
                      <button
                        type="button"
                        onClick={() => {
                          pickTheme("Find stand-up comedy shows near me this weekend", "Standup Comedy");
                          setOpen(false);
                        }}
                        className="group flex w-full items-center justify-between rounded-xl border border-hairline bg-surface-card/20 p-2.5 text-left transition-all hover:border-cyan-500/40 hover:bg-surface-card/60"
                      >
                        <div className="flex items-center gap-2.5">
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-card text-base">
                            🎤
                          </span>
                          <div>
                            <span className="text-xs font-medium text-ink">Standup Comedy Specials</span>
                            <p className="text-[11px] text-muted">
                              Stand-up shows & open mics this weekend
                            </p>
                          </div>
                        </div>
                        <span className="text-muted-soft group-hover:text-ink">›</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          pickTheme("Find live concerts, indie acoustic gigs, and band performances happening near me", "Live Music Gigs");
                          setOpen(false);
                        }}
                        className="group flex w-full items-center justify-between rounded-xl border border-hairline bg-surface-card/20 p-2.5 text-left transition-all hover:border-cyan-500/40 hover:bg-surface-card/60"
                      >
                        <div className="flex items-center gap-2.5">
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-card text-base">
                            🎸
                          </span>
                          <div>
                            <span className="text-xs font-medium text-ink">Live Music & Indie Concerts</span>
                            <p className="text-[11px] text-muted">
                              Gigs and concerts happening near you
                            </p>
                          </div>
                        </div>
                        <span className="text-muted-soft group-hover:text-ink">›</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          pickTheme("Show upcoming theatre plays and stage performances near me", "Theatre & Plays");
                          setOpen(false);
                        }}
                        className="group flex w-full items-center justify-between rounded-xl border border-hairline bg-surface-card/20 p-2.5 text-left transition-all hover:border-cyan-500/40 hover:bg-surface-card/60"
                      >
                        <div className="flex items-center gap-2.5">
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-card text-base">
                            🎭
                          </span>
                          <div>
                            <span className="text-xs font-medium text-ink">Theatre, Plays & Stage Shows</span>
                            <p className="text-[11px] text-muted">
                              Plays & stage performances coming up
                            </p>
                          </div>
                        </div>
                        <span className="text-muted-soft group-hover:text-ink">›</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          pickTheme("Show open-air cinema, rooftop movie screenings, and indie film festivals", "Rooftop Cinema");
                          setOpen(false);
                        }}
                        className="group flex w-full items-center justify-between rounded-xl border border-hairline bg-surface-card/20 p-2.5 text-left transition-all hover:border-cyan-500/40 hover:bg-surface-card/60"
                      >
                        <div className="flex items-center gap-2.5">
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-card text-base">
                            🎬
                          </span>
                          <div>
                            <span className="text-xs font-medium text-ink">Open-Air & Rooftop Cinema</span>
                            <p className="text-[11px] text-muted">
                              Screenings & film events near you
                            </p>
                          </div>
                        </div>
                        <span className="text-muted-soft group-hover:text-ink">›</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          pickTheme("What live events, comedy shows, or nightlife gigs have entry passes available tonight?", "Tonight's Gigs");
                          setOpen(false);
                        }}
                        className="group flex w-full items-center justify-between rounded-xl border border-hairline bg-surface-card/20 p-2.5 text-left transition-all hover:border-cyan-500/40 hover:bg-surface-card/60"
                      >
                        <div className="flex items-center gap-2.5">
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-card text-base">
                            ⚡
                          </span>
                          <div>
                            <span className="text-xs font-medium text-ink">Tonight&apos;s Last-Minute Gigs</span>
                            <p className="text-[11px] text-muted">
                              Events with tickets still available tonight
                            </p>
                          </div>
                        </div>
                        <span className="text-muted-soft group-hover:text-ink">›</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          pickTheme("Find weekend workshops: pottery, canvas painting, mixology, and culinary masterclasses", "Creative Workshops");
                          setOpen(false);
                        }}
                        className="group flex w-full items-center justify-between rounded-xl border border-dashed border-cyan-500/40 bg-cyan-500/5 p-2.5 text-left transition-all hover:border-cyan-500 hover:bg-cyan-500/10"
                      >
                        <div className="flex items-center gap-2.5">
                          <span className="text-base">🎨</span>
                          <div>
                            <span className="text-xs font-semibold text-ink">Weekend Creative Workshops</span>
                            <p className="text-[11px] text-muted">Pottery, painting, cooking & more</p>
                          </div>
                        </div>
                        <span className="text-xs font-bold text-cyan-700">→</span>
                      </button>
                    </div>
                  </>
                )}

                {/* 5. PLAN — outing templates (all four services, read-only) */}
                {service === 'plan' && (
                  <div className="grid gap-1.5">
                    {PLAN_PRESETS.map((p) => (
                      <button
                        key={p.title}
                        type="button"
                        onClick={() => {
                          pickTheme(p.prompt, p.title);
                          setOpen(false);
                        }}
                        className="group flex w-full items-center justify-between rounded-xl border border-hairline bg-surface-card/20 p-2.5 text-left transition-all hover:border-emerald-500/40 hover:bg-surface-card/60"
                      >
                        <div className="flex items-center gap-2.5">
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-card text-base">
                            {p.emoji}
                          </span>
                          <div>
                            <span className="text-xs font-medium text-ink">{p.title}</span>
                            <p className="text-[11px] text-muted">{p.subtitle}</p>
                          </div>
                        </div>
                        <span className="text-muted-soft group-hover:text-ink">›</span>
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => setView('preferences')}
                      className="group flex w-full items-center justify-between rounded-xl border border-dashed border-emerald-500/40 bg-emerald-500/5 p-2.5 text-left transition-all hover:border-emerald-500"
                    >
                      <div className="flex items-center gap-2.5">
                        <span className="text-base">🎯</span>
                        <div>
                          <span className="text-xs font-semibold text-ink">Budget & Preferences</span>
                          <p className="text-[11px] text-muted">Veg, cuisines, allergies & spend the planner respects</p>
                        </div>
                      </div>
                      <span className="text-xs font-bold text-emerald-700">→</span>
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* ────────────────── NUTRITION VIEW ────────────────── */}
            {view === 'nutrition' && (
              <div className="space-y-3">
                <div className="rounded-xl border border-hairline bg-surface-card/30 p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-ink">Running Order Macros</span>
                    <span className="text-[11px] text-muted-soft">
                      {hasItems ? 'Your current cart' : 'Add items to see macros'}
                    </span>
                  </div>
                  {service === 'food' ? (
                    <div className="mt-2">
                      <MacroMeter
                        kcal={nutritionKcal}
                        protein={nutritionProtein}
                        kcalGoal={kcalGoal}
                        proteinGoal={proteinGoal}
                      />
                    </div>
                  ) : (
                    // Live per-item macros are tracked for Food orders only; a
                    // grocery basket gets a full read via "Analyse My Cart".
                    <p className="mt-2 text-[11px] leading-relaxed text-muted">
                      Tap <span className="font-medium text-ink">Analyse My Cart</span> for a
                      calorie &amp; macro read of your basket against these goals.
                    </p>
                  )}

                  {/* Daily goals — editable here (also settable by chat). */}
                  <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-hairline pt-2.5">
                    <span className="text-[11px] font-medium text-ink">Daily goals</span>
                    <label className="flex items-center gap-1.5 text-[11px] text-muted">
                      <input
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={10000}
                        step={50}
                        value={kcalGoal || ''}
                        onChange={(e) =>
                          onChangeMacroGoals(Math.max(0, Number(e.target.value) || 0), proteinGoal)
                        }
                        placeholder="2000"
                        aria-label="Daily calorie goal (kcal)"
                        className="coral-ring w-20 rounded-md border border-hairline bg-canvas px-2 py-1 text-xs text-ink"
                      />
                      kcal
                    </label>
                    <label className="flex items-center gap-1.5 text-[11px] text-muted">
                      <input
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={500}
                        step={5}
                        value={proteinGoal || ''}
                        onChange={(e) =>
                          onChangeMacroGoals(kcalGoal, Math.max(0, Number(e.target.value) || 0))
                        }
                        placeholder="80"
                        aria-label="Daily protein goal (grams)"
                        className="coral-ring w-16 rounded-md border border-hairline bg-canvas px-2 py-1 text-xs text-ink"
                      />
                      g protein
                    </label>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-soft">
                    Nutrition Concierge Actions
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      onAnalyzeNutrition();
                      setOpen(false);
                    }}
                    disabled={sending || !hasItems}
                    className="flex w-full items-center gap-3 rounded-xl border border-coral/30 bg-coral/5 p-2.5 text-left transition-all hover:border-coral disabled:opacity-50"
                  >
                    <span className="text-base">📊</span>
                    <div className="min-w-0 flex-1">
                      <span className="text-xs font-medium text-ink">Analyse My Cart</span>
                      <p className="text-[11px] text-muted">
                        Full health & macro audit with ingredient breakdowns
                      </p>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      onAllergenSweep();
                      setOpen(false);
                    }}
                    disabled={sending || !hasItems}
                    className="flex w-full items-center gap-3 rounded-xl border border-hairline bg-surface-card/20 p-2.5 text-left transition-all hover:border-coral/40 disabled:opacity-50"
                  >
                    <span className="text-base">🛡️</span>
                    <div className="min-w-0 flex-1">
                      <span className="text-xs font-medium text-ink">Allergen Sweep</span>
                      <p className="text-[11px] text-muted">
                        Scan order for hidden nuts, gluten, dairy or palm oil
                      </p>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      onHealthierPicks();
                      setOpen(false);
                    }}
                    disabled={sending || !hasItems}
                    className="flex w-full items-center gap-3 rounded-xl border border-hairline bg-surface-card/20 p-2.5 text-left transition-all hover:border-coral/40 disabled:opacity-50"
                  >
                    <span className="text-base">✨</span>
                    <div className="min-w-0 flex-1">
                      <span className="text-xs font-medium text-ink">Healthier Picks</span>
                      <p className="text-[11px] text-muted">
                        Find lower-calorie, high-protein or cleaner swaps
                      </p>
                    </div>
                  </button>
                </div>
              </div>
            )}

            {/* ────────────────── PREFERENCES VIEW ────────────────── */}
            {view === 'preferences' && (
              <div className="space-y-3.5">
                {/* Diet Goals */}
                <div>
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-soft">
                    Dietary Requirements
                  </span>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {QUICK_DIETS.map((chip) => {
                      const on = hasPreference(chip);
                      return (
                        <button
                          key={chip}
                          type="button"
                          onClick={() => togglePreference(chip)}
                          className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                            on
                              ? 'border-coral bg-coral/10 font-medium text-coral'
                              : 'border-hairline text-muted hover:border-coral/40 hover:text-ink'
                          }`}
                        >
                          {on ? '✓ ' : '+ '}
                          {chip}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Allergens */}
                <div>
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-soft">
                    Allergens & Avoidances
                  </span>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {ALLERGENS.map((a) => {
                      const on = hasAllergen(a);
                      return (
                        <button
                          key={a}
                          type="button"
                          onClick={() => toggleAllergen(a)}
                          className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                            on
                              ? 'border-error/40 bg-error/10 font-medium text-error'
                              : 'border-hairline text-muted hover:border-coral/40 hover:text-ink'
                          }`}
                        >
                          {on ? '🚫 ' : ''}
                          {a}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Budget Limit */}
                <div className="rounded-xl border border-hairline bg-surface-card/30 p-2.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-ink">Max Budget Ceiling</span>
                    <span className="font-display font-semibold text-coral">
                      {budget > 0 ? `₹${budget}` : 'No cap'}
                    </span>
                  </div>
                  <div className="mt-2 flex items-center gap-1.5">
                    {[0, 300, 500, 800, 1200].map((b) => (
                      <button
                        key={b}
                        type="button"
                        onClick={() => onChangeBudget(b)}
                        className={`flex-1 rounded-lg border py-1 text-[11px] transition-colors ${
                          budget === b
                            ? 'border-coral bg-coral text-on-primary'
                            : 'border-hairline text-muted hover:border-coral/30 hover:text-ink'
                        }`}
                      >
                        {b === 0 ? 'None' : `₹${b}`}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* ────────────────── SMART BASKET VIEW ────────────────── */}
            {view === 'smart_basket' && onSmartBasket && (
              <div className="space-y-3">
                <div>
                  <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-soft">
                    Describe your basket goal
                  </label>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (customBasketGoal.trim()) {
                        onSmartBasket(customBasketGoal.trim());
                        setCustomBasketGoal('');
                        setOpen(false);
                      }
                    }}
                    className="mt-1.5 flex gap-1.5"
                  >
                    <input
                      type="text"
                      value={customBasketGoal}
                      onChange={(e) => setCustomBasketGoal(e.target.value)}
                      placeholder="e.g. High protein day under ₹600..."
                      className="coral-ring flex-1 rounded-xl border border-hairline bg-surface-card/50 px-3 py-2 text-xs text-ink placeholder:text-muted-soft"
                    />
                    <button
                      type="submit"
                      disabled={!customBasketGoal.trim() || sending}
                      className="rounded-xl bg-coral px-3 py-2 text-xs font-semibold text-on-primary transition-colors hover:bg-coral-active disabled:opacity-50"
                    >
                      Build
                    </button>
                  </form>
                </div>

                <div>
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-soft">
                    One-Tap Goals
                  </span>
                  <div className="mt-1.5 space-y-1">
                    {BASKET_PRESETS.map((p) => (
                      <button
                        key={p.label}
                        type="button"
                        onClick={() => {
                          onSmartBasket(p.label);
                          setOpen(false);
                        }}
                        disabled={sending}
                        className="flex w-full items-center gap-2.5 rounded-xl border border-hairline bg-surface-card/20 p-2 text-left text-xs text-body transition-all hover:border-coral/40 hover:bg-surface-card/60 hover:text-ink disabled:opacity-50"
                      >
                        <span className="text-base">{p.emoji}</span>
                        <span className="flex-1 font-medium">{p.label}</span>
                        <span className="text-xs text-coral">→</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* ────────────────── RECIPES VIEW ────────────────── */}
            {view === 'recipes' && (
              <div className="space-y-3">
                {/* Add new recipe dish */}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (newRecipeDish.trim()) {
                      onSaveRecipe(newRecipeDish.trim());
                      setNewRecipeDish('');
                    }
                  }}
                  className="flex gap-1.5"
                >
                  <input
                    type="text"
                    value={newRecipeDish}
                    onChange={(e) => setNewRecipeDish(e.target.value)}
                    placeholder="Save a favorite dish (e.g. Paneer Tikka)..."
                    className="coral-ring flex-1 rounded-xl border border-hairline bg-surface-card/50 px-3 py-2 text-xs text-ink placeholder:text-muted-soft"
                  />
                  <button
                    type="submit"
                    disabled={!newRecipeDish.trim()}
                    className="rounded-xl border border-coral bg-coral/10 px-3 py-2 text-xs font-medium text-coral transition-colors hover:bg-coral hover:text-on-primary disabled:opacity-50"
                  >
                    Save
                  </button>
                </form>

                {/* Recipe List */}
                {recipes.length === 0 ? (
                  <div className="space-y-2 pt-1">
                    <p className="text-[11px] text-muted-soft">Popular starter dishes to cook:</p>
                    {STARTER_RECIPES.slice(0, 6).map((dish) => (
                      <div
                        key={dish}
                        className="flex items-center justify-between rounded-xl border border-hairline bg-surface-card/30 p-2.5 text-xs transition-all hover:bg-surface-card/60"
                      >
                        <span className="font-medium text-ink">{dish}</span>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => {
                              onCookRecipe(dish);
                              setOpen(false);
                            }}
                            disabled={sending}
                            className="rounded-full bg-coral/10 px-2.5 py-1 text-[11px] font-medium text-coral transition-colors hover:bg-coral hover:text-on-primary disabled:opacity-50"
                          >
                            Cook
                          </button>
                          <button
                            type="button"
                            onClick={() => onSaveRecipe(dish)}
                            className="rounded-full border border-hairline px-2.5 py-1 text-[11px] text-muted transition-colors hover:border-coral/40 hover:text-ink"
                          >
                            + Save
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {recipes.map((r) => (
                      <div
                        key={r.id}
                        className="flex items-center justify-between rounded-xl border border-hairline bg-surface-card/20 p-2.5 transition-all hover:bg-surface-card/40"
                      >
                        <div className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-medium text-ink">{r.dish}</span>
                          <span className="text-[10px] text-muted-soft">
                            {r.ingredients && r.ingredients.length > 0
                              ? `${r.ingredients.length} ingredients`
                              : 'Custom recipe'}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => {
                              onCookRecipe(r.dish);
                              setOpen(false);
                            }}
                            disabled={sending}
                            className="rounded-full bg-coral/10 px-2 py-1 text-[11px] font-medium text-coral transition-colors hover:bg-coral hover:text-on-primary disabled:opacity-50"
                          >
                            Cook
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              onCookWithMe(r.dish);
                              setOpen(false);
                            }}
                            disabled={sending}
                            className="rounded-full border border-hairline px-2 py-1 text-[11px] text-body transition-colors hover:border-coral/40 hover:text-ink disabled:opacity-50"
                          >
                            Step Timer
                          </button>
                          {onReorderRecipe && r.ingredients && r.ingredients.length > 0 && (
                            // Deterministic: rebuilds the cart from the saved items
                            // (live prices reconcile on sync) — no agent turn.
                            <button
                              type="button"
                              onClick={() => {
                                onReorderRecipe(r);
                                setOpen(false);
                              }}
                              title="Put this recipe's saved ingredients back in your cart"
                              className="rounded-full border border-hairline px-2 py-1 text-[11px] text-body transition-colors hover:border-coral/40 hover:text-ink"
                            >
                              Reorder
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => onDeleteRecipe(r.id)}
                            className="rounded-full p-1 text-muted-soft transition-colors hover:text-error"
                            title="Remove recipe"
                            aria-label={`Remove ${r.dish} from your recipe book`}
                          >
                            <span aria-hidden="true">×</span>
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ────────────────── THEMES VIEW ────────────────── */}
            {view === 'themes' && (
              <div className="space-y-1.5">
                <button
                  type="button"
                  onClick={() => {
                    pickTheme(
                      'Plan healthy dinners for the whole week on a sensible budget. Give a short day-by-day plan as a Markdown list, then show grocery product picks for the key ingredients.',
                      'Plan my week',
                    );
                    setOpen(false);
                  }}
                  className="group flex w-full items-center justify-between rounded-xl border border-coral/30 bg-coral/5 p-2.5 text-left transition-all hover:border-coral"
                >
                  <div className="flex items-center gap-2.5">
                    <span className="text-base">📅</span>
                    <div>
                      <span className="text-xs font-semibold text-coral">Plan My Whole Week</span>
                      <p className="text-[11px] text-muted">Healthy day-by-day dinners on budget</p>
                    </div>
                  </div>
                  <span className="text-xs font-bold text-coral">→</span>
                </button>

                {THEMES.map((t) => (
                  <button
                    key={t.title}
                    type="button"
                    onClick={() => {
                      pickTheme(t.prompt, t.title);
                      setOpen(false);
                    }}
                    className="group flex w-full items-center justify-between rounded-xl border border-hairline bg-surface-card/20 p-2.5 text-left text-xs transition-all hover:border-coral/40 hover:bg-surface-card/60"
                  >
                    <div className="flex items-center gap-2.5">
                      <span className="text-base">{t.emoji}</span>
                      <div>
                        <span className="font-medium text-ink">{t.title}</span>
                        <p className="text-[11px] text-muted">{t.subtitle}</p>
                      </div>
                    </div>
                    <span className="text-muted-soft">→</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default ConciergeToolsMenu;
