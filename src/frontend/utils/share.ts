// Shareable basket links. Encode the current cart (Instamart or Food) into a
// compact, URL-safe token so a built basket can be handed to someone else — or
// reopened on another device — via `?basket=<token>`. No server, no account:
// the whole basket travels in the link. Decoding is defensive — a malformed,
// truncated, or older-version token yields `null` rather than throwing.

import type { CartLine, FoodCartLine, Service } from '@/shared/types';

const VERSION = 1;
export const BASKET_PARAM = 'basket';

/* Compact wire shapes — short keys keep the URL small. */
interface CompactInsta {
  sp: string; // spinId
  pr: string; // productId
  nm: string; // name
  br: string; // brand
  qd: string; // quantityDescription
  im: string; // imageUrl
  up: number; // unitPrice
  mr: number; // mrp
  qt: number; // quantity
}
interface CompactFood {
  mi: string; // menuItemId
  nm: string; // name
  im: string; // imageUrl
  vg: boolean; // veg
  pr: number; // price
  qt: number; // quantity
}
interface Payload {
  v: number;
  s: Service;
  i?: CompactInsta[]; // instamart lines
  r?: { id: string; n: string }; // food restaurant
  f?: CompactFood[]; // food lines
}

/* ----------------------------- base64url codec ---------------------------- */

function b64urlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 =
    typeof btoa === 'function'
      ? btoa(bin)
      : Buffer.from(s, 'utf8').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(token: string): string {
  const b64 = token.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  const full = b64 + pad;
  if (typeof atob === 'function') {
    const bin = atob(full);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  return Buffer.from(full, 'base64').toString('utf8');
}

/* -------------------------------- encode ---------------------------------- */

export function encodeInstamartBasket(items: CartLine[]): string {
  const payload: Payload = {
    v: VERSION,
    s: 'instamart',
    i: items.map((l) => ({
      sp: l.spinId,
      pr: l.productId,
      nm: l.name,
      br: l.brand,
      qd: l.quantityDescription,
      im: l.imageUrl,
      up: l.unitPrice,
      mr: l.mrp,
      qt: l.quantity,
    })),
  };
  return b64urlEncode(JSON.stringify(payload));
}

export function encodeFoodBasket(
  items: FoodCartLine[],
  restaurantId: string | null,
  restaurantName: string | null,
): string {
  const payload: Payload = {
    v: VERSION,
    s: 'food',
    r: restaurantId ? { id: restaurantId, n: restaurantName ?? '' } : undefined,
    f: items.map((l) => ({
      mi: l.menuItemId,
      nm: l.name,
      im: l.imageUrl,
      vg: l.veg,
      pr: l.price,
      qt: l.quantity,
    })),
  };
  return b64urlEncode(JSON.stringify(payload));
}

/* -------------------------------- decode ---------------------------------- */

export type DecodedBasket =
  | { service: 'instamart'; items: CartLine[]; count: number }
  | {
      service: 'food';
      items: FoodCartLine[];
      restaurantId: string | null;
      restaurantName: string | null;
      count: number;
    };

export function decodeBasket(token: string): DecodedBasket | null {
  try {
    const raw = JSON.parse(b64urlDecode(token)) as Payload;
    if (!raw || raw.v !== VERSION) return null;

    if (raw.s === 'instamart' && Array.isArray(raw.i)) {
      const items: CartLine[] = raw.i
        .filter(Boolean)
        .map((x) => ({
          spinId: String(x.sp ?? ''),
          productId: String(x.pr ?? ''),
          name: String(x.nm ?? 'Item'),
          brand: String(x.br ?? ''),
          quantityDescription: String(x.qd ?? ''),
          imageUrl: String(x.im ?? ''),
          unitPrice: Number(x.up) || 0,
          mrp: Number(x.mr) || 0,
          quantity: Math.max(1, Math.round(Number(x.qt) || 1)),
        }))
        .filter((l) => l.spinId);
      if (!items.length) return null;
      return {
        service: 'instamart',
        items,
        count: items.reduce((n, l) => n + l.quantity, 0),
      };
    }

    if (raw.s === 'food' && Array.isArray(raw.f)) {
      const items: FoodCartLine[] = raw.f
        .filter(Boolean)
        .map((x) => ({
          menuItemId: String(x.mi ?? ''),
          name: String(x.nm ?? 'Dish'),
          imageUrl: String(x.im ?? ''),
          veg: Boolean(x.vg),
          price: Number(x.pr) || 0,
          quantity: Math.max(1, Math.round(Number(x.qt) || 1)),
        }))
        .filter((l) => l.menuItemId);
      if (!items.length) return null;
      return {
        service: 'food',
        items,
        restaurantId: raw.r?.id ?? null,
        restaurantName: raw.r?.n ?? null,
        count: items.reduce((n, l) => n + l.quantity, 0),
      };
    }

    return null;
  } catch {
    return null;
  }
}

/* ------------------------------- url helpers ------------------------------ */

/** Build a shareable URL for the current page carrying the basket token. */
export function buildShareUrl(token: string): string {
  if (typeof window === 'undefined') return '';
  const url = new URL(window.location.href);
  url.searchParams.set(BASKET_PARAM, token);
  return url.toString();
}

/** Read + clear the `?basket=` token from the current URL (no history entry). */
export function takeSharedToken(): string | null {
  if (typeof window === 'undefined') return null;
  const url = new URL(window.location.href);
  const token = url.searchParams.get(BASKET_PARAM);
  return token && token.length > 8 ? token : null;
}

/** Strip the `?basket=` param from the address bar without a navigation. */
export function clearSharedToken(): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has(BASKET_PARAM)) return;
  url.searchParams.delete(BASKET_PARAM);
  window.history.replaceState(null, '', url.toString());
}

/** Copy text to the clipboard, with a legacy fallback. Returns success. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to legacy path */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
