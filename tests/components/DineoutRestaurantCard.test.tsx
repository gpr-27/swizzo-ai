// DineoutRestaurantCard on LIVE render_restaurants_dineout cards (Koramangala)
// and the live walk-in-only KFC (partnerType "NPR" — Swiggy lists it but takes
// no table bookings).
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { DineoutRestaurantCard } from "@/frontend/components/catalog/DineoutRestaurantCard";
import { DINEOUT_WALK_IN_LABEL, markDineoutNoSlots } from "@/frontend/state/dineoutAvailability";
import { liveDineoutRestaurants, liveWalkInRestaurant } from "../fixtures/live";

describe("DineoutRestaurantCard (live render cards)", () => {
  it("a bookable restaurant gets Reserve → which opens its slots", async () => {
    const r = liveDineoutRestaurants()[0];
    expect(r.bookable).toBe(true);
    const onViewSlots = vi.fn();
    render(<DineoutRestaurantCard restaurant={r} onViewSlots={onViewSlots} />);
    expect(screen.queryByText(DINEOUT_WALK_IN_LABEL)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Reserve →" }));
    expect(onViewSlots).toHaveBeenCalledWith(r);
  });

  it("shows only Swiggy's own facts: photo, name, cost for two, distance", () => {
    const r = liveDineoutRestaurants()[0];
    render(<DineoutRestaurantCard restaurant={r} />);
    expect(screen.getByRole("heading", { name: r.name })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: r.name })).toHaveAttribute("src", r.imageUrl);
    if (r.costForTwo) expect(screen.getByText(r.costForTwo)).toBeInTheDocument();
    if (r.distance) expect(screen.getByText(new RegExp(r.distance))).toBeInTheDocument();
  });

  it("an unrated live card (rating '--') says New instead of inventing stars", () => {
    const brau = liveDineoutRestaurants().find((r) => r.id === "1075087")!;
    expect(brau.rating).toBeUndefined();
    render(<DineoutRestaurantCard restaurant={brau} onViewSlots={vi.fn()} />);
    expect(screen.getByText("New")).toBeInTheDocument();
  });

  it("walk-in-only (NPR) KFC: honest badge, no Reserve button", () => {
    const kfc = liveWalkInRestaurant();
    expect(kfc.partnerType).toBe("NPR");
    render(<DineoutRestaurantCard restaurant={kfc} onViewSlots={vi.fn()} />);
    expect(screen.getByText(DINEOUT_WALK_IN_LABEL)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reserve/ })).toBeNull();
  });

  it("turns into walk-in only once a live slot fetch came back empty", () => {
    const r = liveDineoutRestaurants()[2];
    render(<DineoutRestaurantCard restaurant={r} onViewSlots={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Reserve →" })).toBeInTheDocument();
    act(() => markDineoutNoSlots(r.id));
    expect(screen.queryByRole("button", { name: "Reserve →" })).toBeNull();
    expect(screen.getByText(DINEOUT_WALK_IN_LABEL)).toBeInTheDocument();
  });

  it("the AI's best reason is shown on the card", () => {
    render(<DineoutRestaurantCard restaurant={liveDineoutRestaurants()[1]} bestReason="Closest with a free table" />);
    expect(screen.getByText("Closest with a free table")).toBeInTheDocument();
  });
});
