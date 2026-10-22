// ScenesShowPicker on the LIVE list_event_shows capture: "Perfume Making
// Workshop Bangalore" at Koramangala Social — Sat 24 Oct shows (2 pm with
// passes for 1 / 2 / 4, 5 pm with a pass for 1 …) and Sat 31 Oct.
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ScenesShowPicker } from "@/frontend/components/catalog/ScenesShowPicker";
import { sendToPicker, setAutoCartHold } from "@/frontend/utils/pickerBridge";
import type { ScenesShowListing } from "@/shared/types";
import { stubFetch } from "../fixtures/fetch";
import { liveScenesListing } from "../fixtures/live";

// "Now" = Thu 22 Oct 2026, 12:00 IST — before every live show.
const NOW = Date.UTC(2026, 9, 22, 6, 30);
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  setAutoCartHold(false);
});

let seq = 0;
function setup(routes: Parameters<typeof stubFetch>[0] = {}) {
  const listing = liveScenesListing();
  const messageId = `msg-scenes-${++seq}`;
  const f = stubFetch({ "/api/ai-read": { ok: false }, ...routes });
  const onOrderPlaced = vi.fn();
  const utils = render(<ScenesShowPicker listing={listing} messageId={messageId} onOrderPlaced={onOrderPlaced} />);
  const cta = () => utils.container.querySelector<HTMLButtonElement>("[data-picker-cta]")!;
  return { listing, messageId, f, onOrderPlaced, cta, ...utils };
}

describe("ScenesShowPicker (live list_event_shows)", () => {
  it("renders the live event, venue and the first on-sale show + tier by default", () => {
    const { cta } = setup();
    expect(screen.getAllByText(/Perfume Making Workshop Bangalore/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Koramangala Social/).length).toBeGreaterThan(0);
    expect(cta()).toHaveTextContent("Review 1 × Entry Pass For 1 · est. ₹1,699");
    expect(cta()).toBeEnabled();
  });

  it("shows AI picks ranked from the live listing", () => {
    setup();
    const strip = screen.getByText("AI picks").closest("div")!;
    expect(within(strip).getAllByRole("button", { name: "Book this" }).length).toBeGreaterThanOrEqual(1);
  });

  it("chat PICK ('pass for two', 2 tickets) resolves to Swiggy's own tier — selects only", async () => {
    const { messageId, cta, f } = setup();
    act(() => sendToPicker(messageId, { date: "2026-10-24", time: "2:00 pm", ticketName: "pass for two", qty: 2 }));
    expect(cta()).toHaveTextContent("Review 2 × Entry Pass For 2 · est. ₹6,198");
    await new Promise((r) => setTimeout(r, 120)); // revealPick timer
    expect(f.calls.map((c) => c.path).filter((p) => p !== "/api/ai-read")).toEqual([]);
  });

  it("a tier that isn't sold that day gets an inline note instead of a guess", () => {
    const { messageId } = setup();
    act(() => sendToPicker(messageId, { date: "2026-10-31", ticketName: "Entry Pass For 4" }));
    expect(screen.getByRole("status")).toHaveTextContent(/isn't offered/);
  });

  it("revealPick lands on the Review button after a PICK", async () => {
    const { messageId, cta } = setup();
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    act(() => sendToPicker(messageId, { date: "2026-10-24", time: "5:00 pm" }));
    await waitFor(() => expect(scroll.mock.contexts).toContain(cta()));
  });

  it("Book this re-validates seats live first; a just-sold-out tier never reaches create_event_cart", async () => {
    const soldOut = (l: ScenesShowListing): ScenesShowListing => ({
      ...l,
      shows: l.shows.map((s) => ({ ...s, onSale: false, tickets: s.tickets.map((t) => ({ ...t, onSale: false, availableInventory: 0 })) })),
    });
    const { f } = setup({ "/api/scenes/shows": () => ({ ok: true, listing: soldOut(liveScenesListing()) }) });
    const strip = screen.getByText("AI picks").closest("div")!;
    await userEvent.click(within(strip).getAllByRole("button", { name: "Book this" })[0]);
    await screen.findByText(/just sold out/);
    const shows = f.calls.find((c) => c.path === "/api/scenes/shows")!;
    expect(shows.url.searchParams.get("fresh")).toBe("1");
    expect(shows.url.searchParams.get("venueId")).toBe("1084");
    expect(f.calls.some((c) => c.path === "/api/scenes/cart" || c.path === "/api/scenes/order")).toBe(false);
  });

  it("while a plan run holds auto-carts, Book this only selects (no cart, no order)", async () => {
    setAutoCartHold(true);
    const { f, cta } = setup();
    const strip = screen.getByText("AI picks").closest("div")!;
    await userEvent.click(within(strip).getAllByRole("button", { name: "Book this" })[0]);
    expect(cta()).toHaveTextContent(/^Review /);
    expect(f.mutating()).toEqual([]);
  });

  it("the ticket count is clamped to the show's live bounds", async () => {
    const { listing, cta } = setup();
    const show = listing.shows[0];
    const max = Math.min(20, show.maxGuests ?? 20, show.tickets[0].availableInventory ?? 20, show.availableSeats ?? 20);
    const more = screen.getByRole("button", { name: "More tickets" });
    for (let i = 0; i < max + 3; i++) if (!(more as HTMLButtonElement).disabled) await userEvent.click(more);
    expect(cta()).toHaveTextContent(`Review ${max} × Entry Pass For 1`);
  });
});
