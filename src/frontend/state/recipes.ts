'use client';

// Saved recipes (browser-local). A recipe is a dish the user wants to cook.
// Recalling it re-asks the concierge for the ingredient list + fresh product
// picks. Once a cook run resolves we ALSO persist the resolved ingredients
// (spinId + line + quantity) and any timed steps, so a later "Reorder" can
// rebuild the cart deterministically at live prices without another agent turn.
// Newest first, capped.

import type { CartLine } from '@/shared/types';

export interface Recipe {
  id: string;
  dish: string; // e.g. "Chicken biryani"
  createdAt: number; // epoch ms
  // Resolved ingredients captured the last time this dish was cooked, so a
  // one-tap reorder is deterministic (POST /api/cart `set` with these spinIds).
  ingredients?: { spinId: string; line: Omit<CartLine, 'quantity'>; quantity: number }[];
  // Step-by-step (optionally timed) cook guide captured from a Cook-with-me run.
  steps?: { text: string; seconds?: number }[];
}

const KEY = 'swiggy-recipes-v1';
const MAX = 60;

// A curated set of popular starter recipes so the Recipe book is never empty.
// These are just dish names — "cooking" one is still fully dynamic (the agent
// asks your preferences, then live-searches the best product for each ingredient
// and builds your cart). Tap to cook, or save it to your own book.
export const STARTER_RECIPES: string[] = [
  'Paneer butter masala',
  'Chicken biryani',
  'Masala dosa',
  'Veg pulao',
  'Chole bhature',
  'Palak paneer',
  'Egg curry',
  'Poha',
  'Pasta arrabiata',
  'Vegetable upma',
];

function read(): Recipe[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? (arr as Recipe[]) : [];
  } catch {
    return [];
  }
}

function write(list: Recipe[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {
    /* best-effort */
  }
}

export function loadRecipes(): Recipe[] {
  return read().sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Save (or update) a recipe, de-duped by case-insensitive dish name. When a
 * recipe with the same dish already exists, its resolved `ingredients`/`steps`
 * are preserved unless the incoming recipe supplies fresh ones — so saving the
 * same dish again never wipes data captured from a previous cook run.
 */
export function saveRecipe(recipe: Recipe): void {
  const key = recipe.dish.trim().toLowerCase();
  const list = read();
  const existing = list.find((r) => r.dish.trim().toLowerCase() === key);
  const merged: Recipe = existing
    ? {
        ...existing,
        ...recipe,
        // keep a stable id/createdAt across re-saves of the same dish
        id: existing.id,
        createdAt: existing.createdAt,
        ingredients: recipe.ingredients ?? existing.ingredients,
        steps: recipe.steps ?? existing.steps,
      }
    : recipe;
  const rest = list.filter((r) => r.dish.trim().toLowerCase() !== key);
  rest.unshift(merged);
  write(rest);
}

/**
 * Merge a patch into the existing recipe matching `dish` (case-insensitive),
 * preserving id/createdAt and any field the patch doesn't touch. Returns the
 * merged recipe, or null when no recipe with that dish exists (so the caller
 * can decide whether to create one). Used to enrich a recipe with the resolved
 * ingredients/steps captured when a cook run resolves.
 */
export function updateRecipeByDish(
  dish: string,
  patch: Partial<Pick<Recipe, 'ingredients' | 'steps'>>,
): Recipe | null {
  const key = dish.trim().toLowerCase();
  const list = read();
  const idx = list.findIndex((r) => r.dish.trim().toLowerCase() === key);
  if (idx === -1) return null;
  const merged: Recipe = { ...list[idx], ...patch };
  list[idx] = merged;
  write(list);
  return merged;
}

export function deleteRecipe(id: string): void {
  write(read().filter((r) => r.id !== id));
}
