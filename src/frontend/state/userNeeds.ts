// What the user has asked for, in their own words — the last few chat asks plus
// the saved preferences / allergies — for the AI "Should I go?" lines and the
// result shortlists (Dineout / Scenes). Client-only, in memory; nothing is sent
// anywhere except as the `needs` of an /api/ai-read call.

const MAX_ASKS = 5;
let asks: string[] = [];

/** Remember one user chat message (machine prompts sent by chips are skipped). */
export function noteUserAsk(text: string): void {
  const t = text.trim();
  if (!t || t.length > 240 || /\bcall [a-z_]+\b|collectionIdentifier|restaurantId=|eventId=/i.test(t)) return;
  asks = [...asks.filter((a) => a !== t), t].slice(-MAX_ASKS);
}

function stored(key: string): string {
  try {
    return localStorage.getItem(key)?.trim() ?? '';
  } catch {
    return '';
  }
}

/** The user's stated needs as one short text ("" when they said nothing). */
export function currentNeeds(): string {
  const prefs = typeof window === 'undefined' ? '' : stored('swiggy-preferences-v1');
  const allergies = typeof window === 'undefined' ? '' : stored('swiggy-allergies-v1');
  return [
    asks.length ? `Asked: ${asks.join(' / ')}` : '',
    prefs ? `Preferences: ${prefs}` : '',
    allergies ? `Allergies: ${allergies}` : '',
  ]
    .filter(Boolean)
    .join('. ')
    .slice(0, 600);
}
