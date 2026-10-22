// Food-tab actions + context that self-contained Food cards (the meal-plan
// proposal, the cart's add-on editor, the "Ready to order" card) need without
// threading new props through page → ChatThread → MessageBubble. Registered by
// useSwiggyChat on every render (like state/foodAddress.ts); a card calls them
// only on a user tap. Nothing here places an order.

import { useSyncExternalStore } from "react";
import type { FoodCartLine, FoodCartSelection } from "@/shared/types";

export interface FoodActions {
  /** Put an approved meal plan in the cart (parks a cart from another restaurant). */
  applyMealPlan: (
    lines: { line: Omit<FoodCartLine, "quantity">; quantity: number }[],
    restaurantId: string,
    restaurantName: string,
  ) => void;
  /** Replace one cart line's variants / add-ons (re-synced to Swiggy). */
  setLineSelection: (menuItemId: string, selection: FoodCartSelection, note?: string) => void;
  /** Send a follow-up chat turn in the Food tab. */
  sendChat: (text: string, displayText?: string) => void;
  /** Remember the meal proposal's outcome on its chat message (survives reload). */
  setMealPlanStatus: (messageId: string, status: "approved" | "dismissed") => void;
}

export interface FoodContext {
  addressId: string;
  addressLine: string; // the selected delivery address, as Swiggy lists it
}

let actions: FoodActions | null = null;
let context: FoodContext = { addressId: "", addressLine: "" };
const listeners = new Set<() => void>();

export function registerFoodActions(next: FoodActions): void {
  actions = next;
}

export function foodActions(): FoodActions | null {
  return actions;
}

export function setFoodContext(next: FoodContext): void {
  if (next.addressId === context.addressId && next.addressLine === context.addressLine) return;
  context = next;
  for (const l of listeners) l();
}

/** The Food tab's delivery context, reactive. */
export function useFoodContext(): FoodContext {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => context,
    () => context,
  );
}
