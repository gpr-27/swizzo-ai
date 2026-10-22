'use client';

// Loads the proactive home briefing for an EMPTY tab (POST /api/briefing) —
// never blocks: the tab renders its static welcome at once and the briefing
// slides in when ready; on any error it simply stays static. One request per
// (user, tab, address, meal-time hour) per 3 minutes, cached in memory.

import { useEffect, useState } from 'react';
import type { Briefing } from '@/backend/briefing/briefing';
import { loadBookings } from '@/frontend/state/bookings';
import type { GeneratedBy, Service } from '@/shared/types';

export interface HomeBriefingData {
  briefing: Briefing;
  ai?: { text: string; model: GeneratedBy };
}

const TTL_MS = 3 * 60_000;
const cache = new Map<string, { at: number; data: HomeBriefingData | null }>();
const inflight = new Map<string, Promise<HomeBriefingData | null>>();

async function fetchBriefing(service: Service, addressId: string, userId?: string): Promise<HomeBriefingData | null> {
  try {
    const bookings = loadBookings(userId).map((b) => ({ kind: b.kind, orderId: b.orderId, title: b.title, details: b.details }));
    const res = await fetch('/api/briefing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service, addressId, bookings }),
    });
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as ({ ok?: boolean } & Partial<HomeBriefingData>) | null;
    return data?.ok && data.briefing ? { briefing: data.briefing, ...(data.ai ? { ai: data.ai } : {}) } : null;
  } catch {
    return null;
  }
}

export function useHomeBriefing(
  service: Service,
  addressId: string,
  userId: string | undefined,
  enabled: boolean,
): HomeBriefingData | null {
  const hour = new Date().getHours();
  const key = `${userId || 'anon'}|${service}|${addressId}|${hour}`;
  const [state, setState] = useState<{ key: string; data: HomeBriefingData | null } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- cached briefing for this tab
      setState({ key, data: hit.data });
      return;
    }
    let alive = true;
    let p = inflight.get(key);
    if (!p) {
      p = fetchBriefing(service, addressId, userId).then((data) => {
        cache.set(key, { at: Date.now(), data });
        inflight.delete(key);
        return data;
      });
      inflight.set(key, p);
    }
    void p.then((data) => {
      if (alive) setState({ key, data });
    });
    return () => {
      alive = false;
    };
  }, [key, enabled, service, addressId, userId]);

  return enabled && state?.key === key ? state.data : null;
}
