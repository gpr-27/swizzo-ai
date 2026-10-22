// ProductCard / pack picker on the LIVE search_products "toned milk" result:
// Amul Moti Toned Milk comes as "450 ml x 2" (₹58) and "450 ml" (₹29).
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ProductCard } from "@/frontend/components/catalog/ProductCard";
import { liveMilkProducts, liveProducts } from "../fixtures/live";

const milk = () => liveMilkProducts().find((p) => p.name === "Amul Moti Toned Milk")!;

function renderCard(props: Partial<Parameters<typeof ProductCard>[0]> = {}) {
  const onAdd = vi.fn();
  const product = props.product ?? milk();
  render(<ProductCard product={product} inCartQty={() => 0} onAdd={onAdd} {...props} />);
  return { onAdd, product };
}

const openDetails = () => userEvent.click(screen.getByRole("button", { name: /^Details for / }));
const packButton = (label: string) => screen.getByRole("button", { name: new RegExp(`^${label.replace(/[x]/g, "\\$&")}\\s*₹`) });

describe("ProductCard pack picker (live Instamart data)", () => {
  it("defaults to the SMALLEST pack, not Swiggy's first variation", async () => {
    const p = milk();
    expect(p.variations.map((v) => v.quantityDescription)).toEqual(["450 ml x 2", "450 ml"]); // live order
    renderCard();
    // the card itself stays short: pack sizes + AI pack live in the details popup
    expect(screen.queryByText(/AI pack/)).toBeNull();
    await openDetails();
    expect(packButton("450 ml")).toHaveAttribute("aria-pressed", "true");
    expect(packButton("450 ml x 2")).toHaveAttribute("aria-pressed", "false");
    // the AI pack line explains why
    expect(screen.getByText(/AI pack/)).toBeInTheDocument();
    expect(screen.getByText(/smallest pack/)).toBeInTheDocument();
  });

  it("Add sends the selected (smallest) pack's real ids", async () => {
    const { onAdd, product } = renderCard();
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(onAdd).toHaveBeenCalledTimes(1);
    const [, variation] = onAdd.mock.calls[0];
    expect(variation.spinId).toBe("W6MKHU9IKH");
    expect(variation.offerPrice).toBe(29);
    expect(onAdd.mock.calls[0][0]).toBe(product);
  });

  it("a manual tap on another pack wins and is what gets added", async () => {
    const { onAdd } = renderCard();
    await openDetails();
    await userEvent.click(packButton("450 ml x 2"));
    expect(packButton("450 ml x 2")).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getAllByRole("button", { name: "Add" })[0]);
    expect(onAdd.mock.calls[0][1].spinId).toBe("LG3284WMD5");
  });

  it("an agent BEST flag on a pack overrides the default and shows the badge", async () => {
    renderCard({ bestReason: (spin) => (spin === "LG3284WMD5" ? "two days of milk" : undefined) });
    expect(screen.getByText(/Best pick/)).toBeInTheDocument();
    expect(screen.queryByText(/two days of milk/)).toBeNull();
    await openDetails();
    expect(packButton("450 ml x 2")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/two days of milk/)).toBeInTheDocument();
  });

  it("shows Swiggy's real price, MRP and unit price", () => {
    renderCard();
    const card = screen.getByRole("article");
    expect(within(card).getAllByText(/₹29/).length).toBeGreaterThan(0);
    expect(within(card).getByText("₹6.4/100 ml")).toBeInTheDocument();
    expect(within(card).getByRole("img", { name: "Amul Moti Toned Milk" })).toHaveAttribute(
      "src",
      expect.stringMatching(/^https:\/\/media-assets\.swiggy\.com\//),
    );
  });

  it("at Swiggy's per-order cap the Add control is disabled with Swiggy's message", () => {
    renderCard({ inCartQty: (spin) => (spin === "W6MKHU9IKH" ? 20 : 0) });
    expect(screen.getByRole("button", { name: /Add another Amul Moti Toned Milk, 20 in cart/ })).toBeDisabled();
    expect(screen.getAllByText("Only 20 unit(s) of this item can be added per order.").length).toBeGreaterThan(0);
  });

  it("single-variation products show their pack size without a picker", () => {
    const single = liveProducts("im_your_go_to_items.json").find((p) => p.variations.length === 1)!;
    renderCard({ product: single });
    expect(screen.queryByRole("button", { pressed: true })).toBeNull();
    expect(screen.queryByText(/sizes/)).toBeNull();
    expect(screen.getByText(single.variations[0].quantityDescription)).toBeInTheDocument();
  });
});
