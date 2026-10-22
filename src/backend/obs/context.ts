// Per-request context (requestId, route) carried through async work with
// AsyncLocalStorage, so deep code — the MCP client, the LLM chain — logs with
// the id of the request that caused it. Entered by withObservability (./route.ts).
//
// The id is Vercel's `x-vercel-id` when present (it matches the platform's own
// request logs), else an incoming `x-request-id` (sanitised), else a fresh one.
// It is echoed to the browser as the `x-request-id` response header and in
// every API error body, so a user-reported problem can be found in the logs.

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export interface RequestContext {
  requestId: string;
  route?: string;
  startedAt: number;
}

const g = globalThis as unknown as { __swizzoRequestContext?: AsyncLocalStorage<RequestContext> };
const storage = (g.__swizzoRequestContext ??= new AsyncLocalStorage<RequestContext>());

export const REQUEST_ID_HEADER = "x-request-id";

/** The request id for an incoming request (never trusts arbitrary client input). */
export function requestIdFrom(headers: Headers): string {
  const vercel = headers.get("x-vercel-id");
  if (vercel && /^[\w:.-]{6,120}$/.test(vercel)) return vercel;
  const incoming = headers.get(REQUEST_ID_HEADER);
  if (incoming && /^[\w-]{8,64}$/.test(incoming)) return incoming;
  return randomUUID();
}

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}
