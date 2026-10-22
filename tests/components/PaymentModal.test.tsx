// PaymentModal: desktop gets a QR to scan, a phone gets the UPI app link.
// No UPI order is ever placed by tests, so there is no live PENDING_PAYMENT
// capture: the session follows the documented place-order UPI response
// (docs/swiggy-mcp/platform.md §6.3) with obviously-placeholder ids, and the
// check_payment_status long-poll is held open so nothing is ever confirmed.
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PaymentModal } from "@/frontend/components/features/PaymentModal";
import type { PaymentSession } from "@/shared/types";
import { never, stubFetch } from "../fixtures/fetch";

const session = (over: Partial<PaymentSession> = {}): PaymentSession => ({
  orderId: "TEST-ORDER-1",
  paasId: "TEST-PAAS-1",
  bridgeUrl: "https://pay.example.invalid/bridge/TEST-PAAS-1",
  upiIntentUrl: "upi://pay?pa=test@example&pn=Test&am=266.00&tr=TEST-PAAS-1",
  paymentMethod: "UPI",
  status: "pending",
  pollingIntervalInMs: 5000,
  maxTimeToPollForInMs: 300_000,
  amount: 266,
  service: "instamart",
  title: "Instamart order",
  ...over,
});

function setup(s: PaymentSession, statusReply: () => unknown = never) {
  const f = stubFetch({ "/api/payments/status": statusReply, "/api/payments/confirm": () => ({ ok: true, result: { result: "success" } }) });
  const onClose = vi.fn();
  const onSuccess = vi.fn();
  const onRetry = vi.fn();
  render(<PaymentModal session={s} onClose={onClose} onSuccess={onSuccess} onRetry={onRetry} />);
  return { f, onClose, onSuccess, onRetry };
}

describe("PaymentModal", () => {
  it("desktop: renders a scannable QR of Swiggy's upi://pay link, no 'UPI app on this phone' button", async () => {
    setup(session());
    expect(screen.getByRole("dialog", { name: "Complete your UPI payment" })).toBeInTheDocument();
    const qr = await screen.findByRole("img", { name: "Payment QR code" });
    expect(qr.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
    expect(screen.getByText(/Scan with any UPI app on your phone/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Pay with a UPI app on this phone" })).toBeNull();
    expect(screen.getByRole("link", { name: "Open Swiggy payment page" })).toHaveAttribute("href", session().bridgeUrl);
    expect(screen.getByText("₹266")).toBeInTheDocument();
  });

  it("desktop without a upi:// link: the QR opens Swiggy's payment page on the phone", async () => {
    setup(session({ upiIntentUrl: undefined }));
    await screen.findByRole("img", { name: "Payment QR code" });
    expect(screen.getByText(/opens Swiggy's payment page there/)).toBeInTheDocument();
  });

  it("mobile: no QR — the UPI app link and Swiggy's payment page instead", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148");
    setup(session());
    expect(screen.getByRole("link", { name: "Pay with a UPI app on this phone" })).toHaveAttribute("href", session().upiIntentUrl);
    expect(screen.getByRole("link", { name: "Open Swiggy payment page" })).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("img", { name: "Payment QR code" })).toBeNull();
  });

  it("polls check_payment_status with the session's ids, one request at a time, never confirms while pending", async () => {
    const { f } = setup(session());
    await waitFor(() => expect(f.calls.filter((c) => c.path === "/api/payments/status")).toHaveLength(1));
    const q = f.calls[0].url.searchParams;
    expect(q.get("orderId")).toBe("TEST-ORDER-1");
    expect(q.get("paasId")).toBe("TEST-PAAS-1");
    expect(q.get("service")).toBe("instamart");
    await new Promise((r) => setTimeout(r, 50));
    expect(f.calls.filter((c) => c.path === "/api/payments/status")).toHaveLength(1);
    expect(f.calls.some((c) => c.path === "/api/payments/confirm")).toBe(false);
    expect(screen.getByRole("button", { name: "Checking with Swiggy…" })).toBeDisabled();
  });

  it("a terminal failure says no order was placed and offers another payment", async () => {
    const { f } = setup(session(), () => ({
      ok: true,
      status: { status: "failed", terminal: true, isTerminalSuccess: false, isTerminalFailure: true, confirmed: false },
    }));
    await screen.findByText("The payment failed. No order was placed.");
    expect(screen.getByRole("button", { name: "Try another payment" })).toBeInTheDocument();
    expect(f.calls.some((c) => c.path === "/api/payments/confirm")).toBe(false);
  });

  it("an expired Swiggy session (401) asks to log in again", async () => {
    setup(session(), () => new Response("Unauthorized", { status: 401 }));
    await screen.findByText(/Your Swiggy session expired/);
  });

  it("renders nothing without a session", () => {
    stubFetch({});
    const { container } = render(<PaymentModal session={null} onClose={vi.fn()} onSuccess={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
