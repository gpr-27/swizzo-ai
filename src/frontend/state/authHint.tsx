'use client';

// Server-provided hint: does this request carry a Swiggy session cookie at all?
// No cookie means the visitor is certainly logged out, so the login screen can
// be server-rendered (instant LCP) instead of appearing only after the client
// bundle has loaded and an API call has 401'd. A present cookie proves nothing
// (it may be expired), so that case keeps the normal client-side check.

import { createContext, useContext, type ReactNode } from 'react';

const AuthHintContext = createContext<boolean | null>(null);

export function AuthHintProvider({ hasSession, children }: { hasSession: boolean; children: ReactNode }) {
  return <AuthHintContext.Provider value={hasSession}>{children}</AuthHintContext.Provider>;
}

/** true = certainly logged out (no session cookie); false = unknown / maybe logged in. */
export function useCertainlyLoggedOut(): boolean {
  return useContext(AuthHintContext) === false;
}
