// MessageBubble: "shown above" links instead of re-drawing cards, and Plan
// replies folding the research cards (live Dineout render cards) under the
// itinerary.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { MessageBubble, type MessageBubbleProps } from "@/frontend/components/chat/MessageBubble";
import type { ChatMessage } from "@/shared/types";
import { stubFetch } from "../fixtures/fetch";
import { liveDineoutRestaurants, liveMilkProducts } from "../fixtures/live";

function props(message: ChatMessage): MessageBubbleProps {
  const noop = vi.fn();
  return {
    message,
    sending: false,
    inCartQty: () => 0,
    onAdd: noop,
    onLoadMore: noop,
    isLoadingMore: () => false,
    openMenu: noop,
    addFoodItem: noop,
    inFoodCartQty: () => 0,
    onPick: noop,
    isSelected: () => false,
    onToggleCompare: noop,
    onToggleCompareFood: noop,
    onAddCompareWinner: noop,
    onApproveProposal: noop,
    onDismissProposal: noop,
    onApproveAll: noop,
  };
}

const restaurants = liveDineoutRestaurants();
const itinerary = {
  title: "Koramangala evening",
  steps: [
    { time: "8:00 PM", domain: "dineout" as const, title: `Dinner at ${restaurants[0].name}`, ref: restaurants[0].id },
  ],
};

describe("MessageBubble", () => {
  it("links to cards already on screen ('— shown above ↑') and scrolls to them", async () => {
    stubFetch({});
    render(
      <>
        <div id="msg-id-earlier">earlier cards</div>
        <MessageBubble
          {...props({
            id: "id-2",
            role: "assistant",
            text: "The cheapest of those is the 450 ml pack.",
            createdAt: 1,
            shownAbove: [{ label: "Toned milk", messageId: "id-earlier" }],
          })}
        />
      </>,
    );
    const link = screen.getByRole("button", { name: "Toned milk — shown above ↑" });
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    await userEvent.click(link);
    expect(scroll).toHaveBeenCalledTimes(1);
    expect((scroll.mock.contexts[0] as HTMLElement).id).toBe("msg-id-earlier");
    // and nothing was drawn twice
    expect(screen.queryByRole("article")).toBeNull();
  });

  it("without an itinerary, live Dineout cards are shown directly", async () => {
    stubFetch({});
    render(<MessageBubble {...props({ id: "id-3", role: "assistant", text: "Here you go.", createdAt: 1, dineoutRestaurants: restaurants })} />);
    expect(screen.queryByText(/Restaurants the AI compared/)).toBeNull();
    // (the cards may be code-split: wait for them)
    expect((await screen.findAllByRole("heading", { name: restaurants[1].name }, { timeout: 5000 })).length).toBeGreaterThan(0);
  });

  it("under a Plan itinerary, research cards fold behind one closed line", async () => {
    stubFetch({});
    const { container } = render(
      <MessageBubble
        {...props({
          id: "id-4",
          role: "assistant",
          text: "Here's your evening.",
          createdAt: 1,
          itinerary,
          dineoutRestaurants: restaurants,
        })}
      />,
    );
    const summary = screen.getByText(`Restaurants the AI compared (${restaurants.length})`);
    const details = summary.closest("details")!;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    expect(container.querySelectorAll("details")).toHaveLength(1);
    await userEvent.click(summary);
    expect(details.open).toBe(true);
  });

  it("Instamart product groups fold too under an itinerary", () => {
    stubFetch({});
    render(
      <MessageBubble
        {...props({
          id: "id-5",
          role: "assistant",
          text: "Snacks for the walk.",
          createdAt: 1,
          itinerary,
          productGroups: [{ query: "toned milk", products: liveMilkProducts() }],
        } as ChatMessage)}
      />,
    );
    expect(screen.getByText("Products the AI checked · toned milk").closest("details")?.open).toBe(false);
  });

  it("user turns show the short label, never the hidden instruction", () => {
    render(
      <MessageBubble
        {...props({ id: "u1", role: "user", text: "[hidden] call get_events_collection …", displayText: "Comedy", createdAt: 1 })}
      />,
    );
    expect(screen.getByText("Comedy")).toBeInTheDocument();
    expect(screen.queryByText(/hidden/)).toBeNull();
  });
});
