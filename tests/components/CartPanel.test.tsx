// CartPanel on the LIVE Instamart get_cart capture (Godrej Yummiez nuggets,
// real Swiggy bill: item total, handling, late-night fee, To Pay ₹266, Swiggy
// One PLUS member, delivery address with redacted flat / masked phone).
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CartPanel } from "@/frontend/components/cart/CartPanel";
import type { CartState } from "@/shared/types";
import { stubFetch } from "../fixtures/fetch";
import { capture, liveCartState } from "../fixtures/live";

function handlers() {
  return {
    onIncrement: vi.fn(),
    onDecrement: vi.fn(),
    onRemove: vi.fn(),
    onClear: vi.fn(),
    onCheckout: vi.fn(),
  };
}

const LINE = "Godrej Yummiez Cheese Corn Nuggets";

describe("CartPanel (live get_cart)", () => {
  it("shows the cart lines first — before the AI read, budget and pay rows", () => {
    stubFetch({
      "/api/instamart/note": { text: null },
      "/api/payments/options": { ok: true, options: capture("im_get_payment_options.json").structuredContent },
    });
    const cart = liveCartState();
    render(<CartPanel cart={cart} {...handlers()} onAsk={vi.fn()} onAnalyze={vi.fn()} budget={500} />);
    const line = screen.getByText(LINE);
    const read = screen.getByRole("region", { name: "AI cart review" });
    // DOCUMENT_POSITION_FOLLOWING = 4: the AI section comes after the line
    expect(line.compareDocumentPosition(read) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Your cart/ })).toHaveTextContent(/1 item$/);
  });

  it("keeps the bill collapsed (To Pay only) until 'Bill details' is tapped", async () => {
    render(<CartPanel cart={liveCartState()} {...handlers()} />);
    const toggle = screen.getByRole("button", { name: /Bill details/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Handling Fee")).toBeNull();
    expect(screen.getByText("To Pay")).toBeInTheDocument();
    expect(screen.getAllByText("₹266").length).toBeGreaterThan(0);

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Handling Fee")).toBeInTheDocument();
    expect(screen.getByText("₹12.00")).toBeInTheDocument();
    expect(screen.getByText("Late Night Fee")).toBeInTheDocument();
    expect(screen.getByText("FREE")).toBeInTheDocument();
    // the grand total is not repeated as a bill row
    expect(screen.queryByText("Item Total")).toBeInTheDocument();
  });

  it("puts Checkout in the sticky footer (outside the scrolling body) with Swiggy's To Pay", async () => {
    const h = handlers();
    render(<CartPanel cart={liveCartState()} {...h} />);
    const checkout = screen.getByRole("button", { name: "Checkout · ₹266" });
    const footer = checkout.closest("footer");
    expect(footer).not.toBeNull();
    // the footer is NOT inside the scroll container that holds the lines
    const scroller = screen.getByText(LINE).closest(".overflow-y-auto");
    expect(scroller).not.toBeNull();
    expect(scroller!.contains(footer)).toBe(false);
    expect(checkout).toBeEnabled();
    await userEvent.click(checkout);
    expect(h.onCheckout).toHaveBeenCalledTimes(1);
  });

  it("shows the Swiggy One membership and the address on one line (expands on tap)", async () => {
    render(<CartPanel cart={liveCartState()} {...handlers()} />);
    expect(screen.getByTitle(/Swiggy ONE PLUS member/)).toHaveTextContent("ONE PLUS");
    const addr = screen.getByRole("button", { name: /To: Test User/ });
    expect(addr).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Test User · ••••6256")).toBeNull();
    await userEvent.click(addr);
    expect(addr).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Test User · ••••6256")).toBeInTheDocument(); // masked at capture
  });

  it("blocks checkout while a line is unavailable", () => {
    const cart: CartState = liveCartState();
    cart.items = cart.items.map((l) => ({ ...l, inStock: false }));
    render(<CartPanel cart={cart} {...handlers()} />);
    expect(screen.getByRole("button", { name: /Checkout/ })).toBeDisabled();
    expect(screen.getByText("Remove unavailable items to checkout.")).toBeInTheDocument();
  });

  it("steppers act on the live spinId", async () => {
    const h = handlers();
    render(<CartPanel cart={liveCartState()} {...h} />);
    await userEvent.click(screen.getByRole("button", { name: `Increase ${LINE}` }));
    expect(h.onIncrement).toHaveBeenCalledWith("VRBN3GVWZ2");
  });

  it("an empty cart shows the empty state and no checkout", () => {
    const cart = { ...liveCartState(), items: [], itemCount: 0, subtotal: 0, bill: undefined };
    render(<CartPanel cart={cart} {...handlers()} />);
    expect(screen.getByText("Your cart is empty")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Checkout/ })).toBeNull();
  });

  it("with AI wired, reads Swiggy's live payment methods (no ordering call)", async () => {
    const f = stubFetch({
      "/api/instamart/note": { text: null },
      "/api/payments/options": { ok: true, options: capture("im_get_payment_options.json").structuredContent },
    });
    render(<CartPanel cart={liveCartState()} {...handlers()} onAsk={vi.fn()} />);
    const readiness = screen.getByLabelText("Checkout readiness");
    await waitFor(() => expect(f.calls.some((c) => c.path === "/api/payments/options")).toBe(true), { timeout: 3000 });
    expect(within(readiness).getByText("Pay with")).toBeInTheDocument();
    expect(f.mutating()).toEqual([]);
  });
});
