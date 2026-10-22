// jsdom gaps the components rely on (layout / observers / scrolling).
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(() => cleanup());

class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
// IntersectionObserver: never reports "on screen" — live polls stay idle and
// photo backfills never fire, so component tests make no background calls.
globalThis.IntersectionObserver ??= NoopObserver as unknown as typeof IntersectionObserver;
globalThis.ResizeObserver ??= NoopObserver as unknown as typeof ResizeObserver;

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn();
if (!Element.prototype.scrollTo) Element.prototype.scrollTo = vi.fn() as unknown as Element["scrollTo"];
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
