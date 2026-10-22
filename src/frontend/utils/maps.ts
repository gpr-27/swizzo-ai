// "Open in Google Maps" links. Preference order: Swiggy's own locationMapUrl
// (Dineout details), then the venue's coordinates from Swiggy (Scenes
// venueLat/venueLng, list_event_shows venue latLng), then a place search for
// Swiggy's venue name + address. Never the USER's coordinates — those are the
// search origin, not the destination.

export interface MapTarget {
  mapUrl?: string;
  lat?: number;
  lng?: number;
  name?: string;
  address?: string;
}

const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n !== 0;

/** A Google Maps directions / search URL, or "" when there is nothing to point at. */
export function directionsUrl(t: MapTarget): string {
  if (t.mapUrl && /^https:\/\/(www\.)?google\.[a-z.]+\/maps|^https:\/\/maps\.google\.|^https:\/\/maps\.app\.goo\.gl/i.test(t.mapUrl)) {
    // Swiggy's link carries `origin=<search coords>`; drop it so Maps starts from the user's real position.
    try {
      const u = new URL(t.mapUrl);
      u.searchParams.delete('origin');
      return u.toString();
    } catch {
      return t.mapUrl;
    }
  }
  if (ok(t.lat) && ok(t.lng)) {
    return `https://www.google.com/maps/dir/?api=1&destination=${t.lat},${t.lng}`;
  }
  const q = [t.name, t.address].filter(Boolean).join(', ').trim();
  return q ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}` : '';
}
