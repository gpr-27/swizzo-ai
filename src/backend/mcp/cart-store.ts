// Tiny disk persistence for in-memory carts so they survive a dev-server
// restart (not just a page reload). Used by the Food cart route only — the
// Instamart cart is read from Swiggy's server-side cart (get_cart) every time,
// per the docs' "don't cache cart state" rule.
//
// State is written to the OS temp dir (outside the project, so it never trips
// Turbopack's file watcher / HMR). Best-effort: failures are logged, never thrown.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = join(tmpdir(), "swiggy-chat-carts");

function pathFor(name: string): string {
  return join(DIR, `${name}.json`);
}

/** Load a persisted store by name, or null if absent/unreadable. */
export function loadStore<T>(name: string): T | null {
  try {
    return JSON.parse(readFileSync(pathFor(name), "utf8")) as T;
  } catch {
    return null;
  }
}

/** Persist a store by name (best-effort). */
export function saveStore(name: string, data: unknown): void {
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(pathFor(name), JSON.stringify(data));
  } catch (err) {
    console.error(`[cart-store] save "${name}" failed:`, err);
  }
}
