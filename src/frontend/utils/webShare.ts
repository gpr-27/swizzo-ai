// Share a booking / itinerary / cart: the Web Share API where the device has
// it (mobile share sheet), else copy to the clipboard; plus a WhatsApp link.

import { copyToClipboard } from './share';

export interface SharePayload {
  title: string;
  text: string;
  url?: string;
}

export type ShareOutcome = 'shared' | 'copied' | 'cancelled' | 'failed';

/** navigator.share → clipboard fallback. "cancelled" when the user closed the share sheet. */
export async function shareOrCopy(p: SharePayload): Promise<ShareOutcome> {
  const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & { canShare?: (d: ShareData) => boolean }) : null;
  const data: ShareData = { title: p.title, text: p.text, ...(p.url ? { url: p.url } : {}) };
  if (nav?.share && (!nav.canShare || nav.canShare(data))) {
    try {
      await nav.share(data);
      return 'shared';
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') return 'cancelled';
      // fall through to the clipboard
    }
  }
  const ok = await copyToClipboard([p.text, p.url].filter(Boolean).join('\n'));
  return ok ? 'copied' : 'failed';
}

/** wa.me link that opens WhatsApp with the text pre-filled. */
export function whatsappUrl(text: string, url?: string): string {
  return `https://wa.me/?text=${encodeURIComponent([text, url].filter(Boolean).join('\n'))}`;
}
