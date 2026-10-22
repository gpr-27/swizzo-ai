// History page ("Orders", like the Swiggy app) — pure mappers from the live
// Swiggy payloads to the dashboard's order rows. No I/O here, so the route and
// scripts/verify-history.ts run exactly the same code.
//
// Food: get_food_orders `orders[]` (up to 15, newest first, across ALL
// addresses). Each order carries a REORDER action whose `reorderMeta` holds the
// real line items (itemId, variants{variationId, groupId, name, price},
// quantity, subtotal) and the restaurant cover image id — that is what Reorder
// rebuilds the Food cart from. Nothing is invented: a missing field stays empty.
// Instamart: get_orders `orders[]` (last 15 days only).

import { idStr, isRecord, num, str } from "@/backend/mcp/client";
import { IMG_THUMB, swiggyImageUrl } from "@/backend/mcp/image";

export type HistoryService = "food" | "instamart";
export type StatusTone = "active" | "success" | "cancelled" | "neutral";

/** One line of a past Food order, in the shape the Food cart needs to re-add it. */
export interface ReorderItem {
  itemId: string; // menu_item_id
  name: string;
  quantity: number;
  veg: boolean | null;
  unitPrice: number; // per-unit subtotal at order time (Swiggy re-prices in the cart)
  // legacy "variations" format — update_food_cart `variants[{group_id, variation_id}]`
  variants: { groupId: string; variationId: string; name: string }[];
  addons: { groupId: string; choiceId: string; name: string; price: number }[];
}

export interface HistoryOrder {
  service: HistoryService;
  orderId: string;
  title: string; // restaurant / store
  area?: string;
  items?: string; // Swiggy's own summary, e.g. "Chicken rice (1)"
  itemCount: number;
  total?: string; // "₹341" exactly as Swiggy formatted it
  totalValue: number | null; // 341 (for the "total spent" summary)
  placedAt?: string; // "October 14, 3:11 PM"
  status: string; // "Delivered" / "Cancelled" / live status
  tone: StatusTone;
  active: boolean;
  imageUrl?: string;
  restaurantId?: string;
  reorder?: { restaurantId: string; restaurantName: string; items: ReorderItem[] };
  // Food get_food_orders extras
  orderType?: string; // "regular" …
  rateActions?: string[]; // enabled RATE_* CTAs — rating happens in the Swiggy app (no tool)
}

export type HistorySection =
  | { ok: true; orders: HistoryOrder[]; note?: string }
  | { ok: false; error: string; needsLogin?: boolean };

export interface HistoryResponse {
  food: HistorySection;
  instamart: HistorySection;
  fetchedAt: number;
}

const titleCase = (s: string) =>
  s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase().replace(/_/g, " ") : "";

/** "₹1,234.50" / "341" / 341 → 1234.5; null when there's no number. */
export function rupeeValue(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const m = v.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

export function toneOf(status: string, active: boolean): StatusTone {
  if (/cancel|fail|reject|refund/i.test(status)) return "cancelled";
  if (active) return "active";
  if (/deliver|complete|success/i.test(status)) return "success";
  return "neutral";
}

function reorderItemsOf(meta: Record<string, unknown>): ReorderItem[] {
  const out: ReorderItem[] = [];
  for (const raw of Array.isArray(meta.orderItems) ? meta.orderItems : []) {
    if (!isRecord(raw)) continue;
    const itemId = idStr(raw.itemId);
    const name = str(raw.name);
    if (!itemId || !name) continue;
    const quantity = Math.max(1, Math.round(num(raw.quantity, 1)));
    const variants = (Array.isArray(raw.variants) ? raw.variants : [])
      .filter(isRecord)
      .map((v) => ({ groupId: idStr(v.groupId ?? v.group_id), variationId: idStr(v.variationId ?? v.variation_id), name: str(v.name) }))
      .filter((v) => v.groupId && v.variationId);
    const addons = (Array.isArray(raw.addons) ? raw.addons : [])
      .filter(isRecord)
      .map((a) => ({
        groupId: idStr(a.groupId ?? a.group_id),
        choiceId: idStr(a.choiceId ?? a.choice_id),
        name: str(a.name),
        price: num(a.price, 0),
      }))
      .filter((a) => a.groupId && a.choiceId);
    const subtotal = num(raw.subtotal, NaN);
    const veg = raw.isVeg === undefined ? null : String(raw.isVeg) === "1";
    out.push({
      itemId,
      name,
      quantity,
      veg,
      unitPrice: Number.isFinite(subtotal) ? Math.round((subtotal / quantity) * 100) / 100 : 0,
      variants,
      addons,
    });
  }
  return out;
}

/** Enabled RATE_* CTAs ("RATE DELIVERY" → "Rate delivery"). */
function rateActionsOf(actions: Record<string, unknown>[]): string[] {
  const out: string[] = [];
  for (const a of actions) {
    if (a.isEnabled === false || !/RATE/i.test(str(a.type))) continue;
    const label = titleCase(str(a.title)) || "Rate order";
    if (!out.includes(label)) out.push(label);
  }
  return out;
}

/** get_food_orders `orders[]` → History rows (keeps Swiggy's order). */
export function mapFoodHistory(orders: unknown[]): HistoryOrder[] {
  return orders.filter(isRecord).map((o) => {
    const actions = Array.isArray(o.actions) ? o.actions.filter(isRecord) : [];
    const reorderAction = actions.find(
      (a) => isRecord(a.reorderMeta) && a.isEnabled !== false && /REORDER/i.test(str(a.type) || str(a.title)),
    );
    const meta = reorderAction && isRecord(reorderAction.reorderMeta) ? reorderAction.reorderMeta : null;
    const cover = meta ? str(meta.restaurantCoverImageId) : "";
    const active = o.isActiveOrder === true;
    const rawStatus = str(o.orderStatus) || str(o.orderDeliveryStatus);
    const status = titleCase(rawStatus) || (active ? "In progress" : "Unknown");
    const restaurantId = idStr(o.restaurantId);
    const title = str(o.restaurantName, "Restaurant");
    const items = meta ? reorderItemsOf(meta) : [];
    const summary = str(o.orderedItems);
    const countFromSummary = summary
      ? summary.split(/,(?![^(]*\))/).reduce((n, part) => n + (Number(part.match(/\((\d+)\)\s*$/)?.[1]) || 1), 0)
      : 0;
    return {
      service: "food" as const,
      orderId: idStr(o.orderId),
      title,
      area: str(o.restaurantAreaName) || undefined,
      items: summary || undefined,
      itemCount: items.length ? items.reduce((n, i) => n + i.quantity, 0) : countFromSummary,
      total: str(o.orderTotal) || undefined,
      totalValue: rupeeValue(o.orderTotal),
      placedAt: str(o.orderedTime) || undefined,
      status,
      tone: toneOf(rawStatus, active),
      active,
      imageUrl: swiggyImageUrl(cover, IMG_THUMB * 2) || undefined,
      restaurantId: restaurantId || undefined,
      ...(restaurantId && items.length ? { reorder: { restaurantId, restaurantName: title, items } } : {}),
      ...(str(o.orderType) ? { orderType: str(o.orderType) } : {}),
      ...(rateActionsOf(actions).length ? { rateActions: rateActionsOf(actions) } : {}),
    };
  });
}

/** get_orders `orders[]` → History rows. Field names per the docs + common spellings. */
export function mapInstamartHistory(orders: unknown[]): HistoryOrder[] {
  return orders.filter(isRecord).map((o) => {
    const lines = Array.isArray(o.items) ? o.items.filter(isRecord) : [];
    const summary = lines
      .map((i) => {
        const name = str(i.name) || str(i.itemName) || str(i.displayName);
        const q = num(i.quantity, 0);
        return name ? (q ? `${name} (${q})` : name) : "";
      })
      .filter(Boolean)
      .join(", ");
    const rawStatus = str(o.statusMessage) || str(o.currentStatus) || str(o.status) || str(o.historyStatus);
    const delivered = /delivered/i.test(rawStatus);
    const active = o.isActive === true && !delivered;
    const total = o.orderTotal ?? o.totalAmount ?? o.totalPrice ?? o.amount;
    const totalValue = rupeeValue(total);
    const image = lines.map((i) => str(i.imageUrl) || str(i.image)).find(Boolean) || "";
    const status = delivered ? "Delivered" : titleCase(rawStatus.split(/[,—]/)[0].trim()) || "Unknown";
    return {
      service: "instamart" as const,
      orderId: idStr(o.orderId),
      title: str(o.storeName, "Instamart"),
      items: summary || undefined,
      itemCount: num(o.itemCount, 0) || lines.reduce((n, i) => n + Math.max(1, num(i.quantity, 1)), 0),
      total:
        typeof total === "string" && total.trim()
          ? total.trim()
          : totalValue !== null
            ? `₹${totalValue.toLocaleString("en-IN")}`
            : undefined,
      totalValue,
      placedAt: str(o.orderTime) || str(o.createdAt) || str(o.orderedTime) || undefined,
      status,
      tone: toneOf(rawStatus, active),
      active,
      imageUrl: swiggyImageUrl(image, IMG_THUMB * 2) || undefined,
    };
  });
}

/** Merge order lists from several get_orders calls (DASH + INSTAMART), de-duplicated by orderId. */
export function dedupeOrders(lists: unknown[][]): Record<string, unknown>[] {
  const seen = new Set<string>();
  const out: Record<string, unknown>[] = [];
  for (const list of lists) {
    for (const o of list) {
      if (!isRecord(o)) continue;
      const id = idStr(o.orderId);
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      out.push(o);
    }
  }
  return out;
}

/** The Swiggy web tracking page (track_food_order: "trackUrl https://www.swiggy.com/track-order/<orderId>"). */
export function foodTrackUrl(payload: unknown, orderId: string): string {
  const root = isRecord(payload) ? payload : {};
  const orders = Array.isArray(root.orders) ? root.orders.filter(isRecord) : [];
  const mine = orders.find((o) => idStr(o.orderId) === orderId) ?? orders[0];
  const fromPayload = (mine && str(mine.trackUrl)) || str(root.trackUrl);
  if (/^https:\/\/www\.swiggy\.com\//.test(fromPayload)) return fromPayload;
  const fromText = str(root.text).match(/https:\/\/www\.swiggy\.com\/track-order\/\S+/)?.[0];
  return fromText || `https://www.swiggy.com/track-order/${encodeURIComponent(orderId)}`;
}
