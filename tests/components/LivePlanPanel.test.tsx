// LivePlanPanel: the per-step live statuses derived by planRun.derivePlan from
// a real thread shape — live Scenes listing (picker snapshot), live Dineout
// render cards, a walk-in-only answer — exactly as usePlanRun feeds it.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { LivePlanPanel } from "@/frontend/components/features/LivePlanPanel";
import type { PlanRun } from "@/frontend/hooks/usePlanRun";
import * as R from "@/frontend/plan/planRun";
import { buildScenesActivePicker } from "@/shared/picker";
import type { ActivePicker, ChatMessage } from "@/shared/types";
import { stubFetch } from "../fixtures/fetch";
import { liveDineoutRestaurants, liveScenesListing } from "../fixtures/live";

const T0 = Date.UTC(2026, 9, 22, 6, 30);

function scenario(opts: { booked?: boolean } = {}) {
  const listing = liveScenesListing();
  const [dinner] = liveDineoutRestaurants();
  const it = {
    title: "Saturday in Koramangala",
    date: "Sat 24 Oct",
    party: 2,
    budget: 8000,
    steps: [
      { time: "1:00 PM", domain: "other" as const, title: "Walk around Koramangala" },
      { time: "2:00 PM", domain: "scenes" as const, title: "Perfume workshop", ref: listing.eventId },
      { time: "8:00 PM", domain: "dineout" as const, title: `Dinner at ${dinner.name}`, ref: dinner.id },
      { time: "10:30 PM", domain: "food" as const, title: "Dessert at home" },
    ],
  };
  const planMsg: ChatMessage = {
    id: "plan1",
    role: "assistant",
    text: "",
    createdAt: T0,
    itinerary: it,
    scenesEvents: [{ id: listing.eventId, title: listing.eventTitle ?? "", venueName: listing.venueName ?? "", area: listing.venueArea }],
    dineoutRestaurants: [dinner],
  };
  let run = R.adoptItinerary(R.emptyRun(), undefined, planMsg, T0);
  run = { ...run, mode: "running" };
  run = R.markActed(run, 1, "open", listing.eventId, T0);
  run = R.markActed(run, 2, "open", dinner.id, T0);
  const show = listing.shows[0];
  const messages: ChatMessage[] = [
    planMsg,
    { id: "sc1", role: "assistant", text: "", createdAt: T0 + 1, scenesShows: listing },
    // Swiggy's answer when the restaurant takes no table bookings
    { id: "do-slots-u-1", role: "user", text: `Show table slots at ${dinner.name}`, createdAt: T0 + 2 },
    { id: "do-slots-1", role: "assistant", text: `**${dinner.name}** is listed on Swiggy Dineout but isn't taking table bookings there (walk-in only).`, createdAt: T0 + 3 },
  ];
  if (opts.booked) {
    messages.push({
      id: "sc-book-251",
      role: "assistant",
      text: "",
      createdAt: T0 + 4,
      bookingTracker: { kind: "scenes", title: `Entry Pass For 2 · ${listing.eventTitle}`, status: "CONFIRMED", details: "", orderId: "251", amount: 3099 },
    });
  }
  const snaps = new Map<string, ActivePicker>([
    ["sc1", buildScenesActivePicker("sc1", listing, { date: show.date, showId: show.showId, ticketId: show.tickets[1].ticketId, qty: 1 })],
  ]);
  const view = R.derivePlan({ messages, run, snapshot: (id) => (opts.booked ? null : snaps.get(id) ?? null), sending: false, now: T0 + 10, foodCart: { items: [], toPay: 0 } });
  const plan: PlanRun = {
    view,
    run,
    sending: false,
    start: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    doStep: vi.fn(),
    retry: vi.fn(),
    skip: vi.fn(),
    unskip: vi.fn(),
    replan: vi.fn(),
    approve: vi.fn(),
    tryUnavailable: vi.fn(),
    note: vi.fn(),
    setLiveStatus: vi.fn(),
    watch: [],
  };
  return { plan, listing, dinner };
}

const steps = () => [...document.querySelectorAll<HTMLElement>("ol > li")];

describe("LivePlanPanel step statuses", () => {
  it("shows each step's live status: Done (passed stop) · Your turn · Needs a change · Planned", () => {
    stubFetch({});
    const { plan } = scenario();
    render(<LivePlanPanel plan={plan} onReveal={vi.fn()} onOpenCart={vi.fn()} />);
    const items = steps();
    expect(items).toHaveLength(4);
    expect(items[0]).toHaveTextContent("Done"); // a running plan passes a no-booking stop
    expect(items[1]).toHaveTextContent("Your turn");
    expect(items[1]).toHaveTextContent("AI pick: ");
    expect(items[1]).toHaveTextContent("Entry Pass For 2");
    expect(items[2]).toHaveTextContent("Needs a change");
    expect(items[2]).toHaveTextContent(/walk-in only/);
    expect(items[3]).toHaveTextContent("Planned");
  });

  it("the header shows real facts: title, date, party, lined-up ticket price", () => {
    stubFetch({});
    const { plan } = scenario();
    render(<LivePlanPanel plan={plan} onReveal={vi.fn()} onOpenCart={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Saturday in Koramangala" })).toBeInTheDocument();
    expect(screen.getByText(/Sat 24 Oct · 2 people · 4 stops/)).toBeInTheDocument();
    expect(screen.getByText(/₹3,099 lined up/)).toBeInTheDocument(); // the live tier price
    expect(screen.getByRole("button", { name: /Pause/ })).toBeInTheDocument();
  });

  it("Confirm hands over to the step's own picker (reveal), never books", async () => {
    stubFetch({});
    const { plan } = scenario();
    const onReveal = vi.fn();
    render(<LivePlanPanel plan={plan} onReveal={onReveal} onOpenCart={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /Review & confirm tickets/ }));
    expect(onReveal).toHaveBeenCalledWith("sc1");
    expect(plan.note).toHaveBeenCalled();
    expect(plan.approve).not.toHaveBeenCalled();
  });

  it("a failed step offers Replan / Try again", async () => {
    stubFetch({});
    const { plan } = scenario();
    render(<LivePlanPanel plan={plan} onReveal={vi.fn()} onOpenCart={vi.fn()} />);
    const failed = steps()[2];
    await userEvent.click(within(failed).getByRole("button", { name: /Replan step/ }));
    expect(plan.replan).toHaveBeenCalledWith(2);
    await userEvent.click(within(failed).getByRole("button", { name: "Try again" }));
    expect(plan.retry).toHaveBeenCalledWith(2);
  });

  it("after the user's own confirm, Swiggy's booking shows as Booked with its order id", () => {
    stubFetch({});
    const { plan } = scenario({ booked: true });
    render(<LivePlanPanel plan={plan} onReveal={vi.fn()} onOpenCart={vi.fn()} />);
    expect(steps()[1]).toHaveTextContent("Booked");
    expect(steps()[1]).toHaveTextContent("order 251");
    expect(screen.getByText(/₹3,099 paid/)).toBeInTheDocument();
  });

  it("renders nothing without a plan", () => {
    const { plan } = scenario();
    const { container } = render(<LivePlanPanel plan={{ ...plan, view: null }} onReveal={vi.fn()} onOpenCart={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
