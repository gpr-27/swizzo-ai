// DineoutSlotPicker on the LIVE get_available_slots capture for Si Nonna's
// (restaurant 1032642, 23 Oct 2026): 24 slots, Breakfast + Lunch, free table
// reservations and a ₹25 "Flat 15% off" prebook deal.
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DineoutSlotPicker, type DineoutSlotPickerProps } from "@/frontend/components/catalog/DineoutSlotPicker";
import { sendBestPick, sendToPicker, setAutoCartHold } from "@/frontend/utils/pickerBridge";
import { stubFetch } from "../fixtures/fetch";
import { liveDineoutSlotsView } from "../fixtures/live";

// "Now" = Fri 23 Oct 2026, 09:00 IST — before the first live slot (11:00 AM).
const NOW = Date.UTC(2026, 9, 23, 3, 30);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  setAutoCartHold(false);
});

let seq = 0;
type BookSlot = NonNullable<DineoutSlotPickerProps["onBookSlot"]>;
function setup() {
  const view = liveDineoutSlotsView();
  const messageId = `msg-dineout-${++seq}`;
  const onBookSlot = vi.fn<BookSlot>(async () => true);
  const f = stubFetch({});
  const utils = render(<DineoutSlotPicker view={view} messageId={messageId} onBookSlot={onBookSlot} />);
  return { view, messageId, onBookSlot, f, ...utils };
}

const cta = (c: HTMLElement) => c.querySelector<HTMLButtonElement>("[data-picker-cta]")!;

describe("DineoutSlotPicker (live slots)", () => {
  it("renders Swiggy's live slots grouped by meal window with real deals", () => {
    const { view, container } = setup();
    expect(view.slots).toHaveLength(24);
    expect(screen.getByRole("heading", { name: "Si Nonna's" })).toBeInTheDocument();
    expect(screen.getByText("Breakfast")).toBeInTheDocument();
    expect(screen.getByText("Lunch")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /11:00 AM/ })).toBeEnabled();
    expect(cta(container)).toHaveTextContent("Pick a time and deal");
    expect(cta(container)).toBeDisabled();
  });

  it("shows 2–3 AI picks ranked from the live slots, each with Book this", () => {
    setup();
    const strip = screen.getByText("AI picks").closest("div")!;
    const books = within(strip).getAllByRole("button", { name: "Book this" });
    expect(books.length).toBeGreaterThanOrEqual(2);
    expect(books.length).toBeLessThanOrEqual(3);
    expect(within(strip).getByText(/Soonest/)).toBeInTheDocument();
  });

  it("picking a slot defaults to its FREE table and books only on the user's Confirm, with verbatim ids", async () => {
    const { container, onBookSlot, f, view } = setup();
    const live = view.slots.find((s) => s.displayTime === "12:00 PM")!;
    await userEvent.click(screen.getByRole("button", { name: /^12:00 PM/ }));
    expect(screen.getByText("Deal for 12:00 PM")).toBeInTheDocument();
    expect(cta(container)).toHaveTextContent("Confirm table for 2 · 12:00 PM");
    expect(onBookSlot).not.toHaveBeenCalled();

    await userEvent.click(cta(container));
    expect(onBookSlot).toHaveBeenCalledTimes(1);
    const [restaurantId, name, choice, guests] = onBookSlot.mock.calls[0];
    expect([restaurantId, name, guests]).toEqual(["1032642", "Si Nonna's", 2]);
    expect(choice.deal.itemId).toBe("1032642-58545"); // the live free deal
    expect(choice.slot.reservationTime).toBe(live.reservationTime); // copied, never rebuilt
    expect(choice.deal.slotId).toBe(live.deals.find((d) => d.isFree)!.slotId);
    expect(choice.payment).toBeUndefined();
    expect(f.mutating()).toEqual([]); // free table: no cart / payment call
  });

  it("the paid ₹25 deal says Continue (create_cart) instead of booking", async () => {
    const { container } = setup();
    await userEvent.click(screen.getByRole("button", { name: /^11:00 AM/ }));
    expect(cta(container)).toHaveTextContent("Continue · ₹25 deal for 2");
  });

  it("chat PICK → applies the selection inside this picker's live data and reveals the CTA", async () => {
    const { container, messageId, onBookSlot } = setup();
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    act(() => sendToPicker(messageId, { date: "2026-10-23", time: "12:30 PM", deal: "free", guests: 4 }));
    expect(cta(container)).toHaveTextContent("Confirm table for 4 · 12:30 PM");
    // revealPick: lands the page on the picker's main button
    await waitFor(() => expect(scroll.mock.contexts).toContain(cta(container)));
    expect(onBookSlot).not.toHaveBeenCalled(); // a PICK selects, never books
  });

  it("a PICK for a time Swiggy doesn't offer leaves a note, not a guess", () => {
    const { container, messageId } = setup();
    act(() => sendToPicker(messageId, { date: "2026-10-23", time: "3:17 AM" }));
    expect(cta(container)).toHaveTextContent("Pick a time and deal");
    expect(screen.getByRole("status")).toHaveTextContent(/./);
  });

  it("Book this on a free AI pick fills the picker and asks for Confirm (no booking yet)", async () => {
    const { container, onBookSlot, f } = setup();
    const strip = screen.getByText("AI picks").closest("div")!;
    const rows = within(strip).getAllByRole("listitem");
    const freeRow = rows.find((li) => /free table/.test(li.textContent ?? ""));
    expect(freeRow, "a live free-table pick").toBeDefined();
    await userEvent.click(within(freeRow!).getByRole("button", { name: "Book this" }));
    expect(screen.getByText("Ready to book — tap Confirm below")).toBeInTheDocument();
    expect(cta(container)).toHaveTextContent(/^Confirm table for 2/);
    expect(onBookSlot).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
  });

  it("one-tap best pick (sendBestPick) selects the top AI pick only", async () => {
    const { container, messageId, onBookSlot } = setup();
    act(() => sendBestPick(messageId));
    await waitFor(() => expect(cta(container)).not.toHaveTextContent("Pick a time and deal"));
    expect(onBookSlot).not.toHaveBeenCalled();
  });

  it("while a plan run holds auto-carts, a paid PICK with confirm only selects (no create_cart)", async () => {
    setAutoCartHold(true);
    const { container, messageId, f } = setup();
    act(() => sendToPicker(messageId, { date: "2026-10-23", time: "11:00 AM", deal: "1032642-1145157", confirm: true }));
    expect(cta(container)).toHaveTextContent("Continue · ₹25 deal for 2");
    await new Promise((r) => setTimeout(r, 20));
    expect(f.calls.filter((c) => c.path === "/api/dineout/cart")).toEqual([]);
  });
});
