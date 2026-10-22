// Reorder: a past Food order's reorderMeta lines → Food cart lines. The cart
// sync (/api/food-cart "set" → updateFoodCart → update_food_cart) sends each
// line's `selection` as `variants: [{ group_id, variation_id }]` — the legacy
// "variations" format, which is exactly what reorderMeta carries
// (variants[{ variationId, groupId }]). Swiggy re-prices and re-checks stock in
// the cart, so `price` is only the order-time figure until the cart syncs.

import type { FoodCartLine } from '@/shared/types';
import type { ReorderItem } from '@/backend/history/history-map';

export function reorderToFoodLines(items: ReorderItem[], images: Record<string, string> = {}): FoodCartLine[] {
  return items.map((it) => {
    const hasSel = it.variants.length > 0 || it.addons.length > 0;
    const detail = [...it.variants.map((v) => v.name), ...it.addons.map((a) => a.name)].filter(Boolean).join(' · ');
    return {
      menuItemId: it.itemId,
      name: it.name,
      imageUrl: images[it.name.toLowerCase()] || '',
      quantity: it.quantity,
      veg: it.veg === true,
      price: it.unitPrice,
      ...(hasSel
        ? {
            selection: { format: 'variations' as const, variants: it.variants, addons: it.addons },
            ...(detail ? { detail } : {}),
          }
        : {}),
    };
  });
}
