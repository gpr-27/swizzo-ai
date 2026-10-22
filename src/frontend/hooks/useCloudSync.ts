'use client';

// Starts / stops the cross-device sync (src/frontend/state/cloudSync.ts) with
// the login state, and calls `onSynced` when server data landed in
// localStorage so the caller can re-read its stores. Inert when the server has
// no database.

import { useEffect, useRef } from 'react';

import { startCloudSync, stopCloudSync } from '@/frontend/state/cloudSync';
import { SYNCED_EVENT, type SyncedChange } from '@/frontend/state/syncBus';

export function useCloudSync(authenticated: boolean, clientUserId: string | undefined, onSynced: (c: SyncedChange) => void): void {
  const cb = useRef(onSynced);
  useEffect(() => {
    cb.current = onSynced;
  }, [onSynced]);

  useEffect(() => {
    const handler = (ev: Event) => cb.current((ev as CustomEvent<SyncedChange>).detail);
    window.addEventListener(SYNCED_EVENT, handler);
    return () => window.removeEventListener(SYNCED_EVENT, handler);
  }, []);

  useEffect(() => {
    if (!authenticated) {
      stopCloudSync();
      return;
    }
    void startCloudSync(clientUserId);
    return () => stopCloudSync();
  }, [authenticated, clientUserId]);
}
