// Per-tab home briefing — what an empty tab shows instead of static prompts.
// Pure: given the REAL data the tab can read cheaply (Food get_food_orders,
// Instamart get_orders, the statuses of bookings made in this app) and the
// current IST time, it returns a headline, live status lines, the facts the
// AI may rephrase (ai-phrase.ts) and exactly three tappable chips tailored to
// the tab and the meal time. Nothing is invented: a chip names a restaurant /
// dish / item only when it came from the user's own orders.

import type { HistoryOrder } from "@/backend/history/history-map";
import { buildHistoryInsights, istHour, mealSlot, orderLines, parseOrderTime, type MealSlot } from "@/backend/history/insights";
import type { Service } from "@/shared/types";

export interface BriefingBooking {
  kind: "dineout" | "scenes";
  orderId: string;
  title: string;
  status?: string;
  details?: string;
}

export interface BriefingInput {
  service: Service;
  nowMs: number;
  food?: HistoryOrder[] | null; // null / undefined = not read (or failed)
  instamart?: HistoryOrder[] | null;
  bookings?: BriefingBooking[];
}

export interface BriefingChip {
  label: string; // what the chip shows
  prompt: string; // what is sent to the tab's agent
}

export interface Briefing {
  service: Service;
  greeting: string; // "Good evening"
  slot: MealSlot;
  headline: string; // deterministic one-liner (the AI may rephrase it)
  lines: string[]; // live status lines (active orders, bookings)
  chips: BriefingChip[]; // exactly 3
  facts: string[]; // everything above, for the AI phrasing
  hasData: boolean; // false → the tab keeps its static welcome copy
}

const chip = (label: string, prompt = label): BriefingChip => ({ label, prompt });

function greetingFor(hour: number): string {
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 17) return "Good afternoon";
  if (hour >= 17 && hour < 22) return "Good evening";
  return "Hey night owl";
}

/** IST weekday 0 (Sun) – 6 (Sat). */
function istDay(nowMs: number): number {
  return new Date(nowMs + 330 * 60_000).getUTCDay();
}

const pretty = (s: string) => s.replace(/_/g, " ").toLowerCase();

function bookingLine(b: BriefingBooking): string {
  const what = b.kind === "dineout" ? (b.title || "Your table") : `Tickets: ${b.title}`;
  const status = b.status ? pretty(b.status) : "";
  return [what, status && `— ${status}`, b.details && `(${b.details})`].filter(Boolean).join(" ");
}

function activeLine(o: HistoryOrder): string {
  return `Your ${o.service === "food" ? "order" : "Instamart order"} from ${o.title} is ${pretty(o.status || "on the way")}`;
}

/** Bookings not cancelled / failed (we don't know which are past without a time, so keep them). */
function liveBookings(list: BriefingBooking[] | undefined, kinds: BriefingBooking["kind"][]): BriefingBooking[] {
  return (list ?? []).filter((b) => kinds.includes(b.kind) && b.status && !/cancel|fail|reject|refund|expired|complet/i.test(b.status));
}

const SLOT_FOOD: Record<MealSlot, BriefingChip> = {
  breakfast: chip("Breakfast delivered fast", "Breakfast options that deliver fast near me"),
  lunch: chip("Quick lunch near me", "A quick, filling lunch that delivers fast near me"),
  "evening snack": chip("Evening snacks", "Evening snacks and chai that deliver fast near me"),
  dinner: chip("Dinner ideas near me", "Top-rated dinner options delivering near me right now"),
  "late-night": chip("Late-night delivery", "What's still open and delivering late at night near me?"),
};

const SLOT_IM: Record<MealSlot, BriefingChip> = {
  breakfast: chip("Breakfast essentials", "Milk, bread and eggs for breakfast"),
  lunch: chip("Quick lunch ingredients", "Ingredients for a quick lunch"),
  "evening snack": chip("Evening snacks", "Snacks for the evening"),
  dinner: chip("Tonight's dinner groceries", "Ingredients for tonight's dinner"),
  "late-night": chip("Late-night munchies", "Late-night munchies"),
};

export function buildBriefing(input: BriefingInput): Briefing {
  const { service, nowMs } = input;
  const hour = istHour(nowMs);
  const slot = mealSlot(hour);
  const greeting = greetingFor(hour);
  const day = istDay(nowMs);
  const weekendSoon = day === 0 || day >= 4; // Thu–Sun
  const food = input.food ?? [];
  const im = input.instamart ?? [];
  const ins = buildHistoryInsights(food, im, [], nowMs);
  const usual = ins.topRestaurants[0] && ins.topRestaurants[0].count >= 2 ? ins.topRestaurants[0] : undefined;
  const usualOrder = usual ? food.find((o) => o.title === usual.name && o.tone !== "cancelled") : undefined;
  const usualDish = usualOrder ? orderLines(usualOrder)[0]?.name : undefined;
  // a "favourite" dish needs at least two real orders of it
  const topDish = ins.topDishes[0] && ins.topDishes[0].count >= 2 ? ins.topDishes[0].name : undefined;
  const lastFood = food.find((o) => o.tone !== "cancelled");
  const lastIm = im.find((o) => o.tone !== "cancelled");

  const lines: string[] = [];
  const chips: BriefingChip[] = [];
  let headline = "";

  const activeFood = food.filter((o) => o.active);
  const activeIm = im.filter((o) => o.active);

  switch (service) {
    case "food": {
      for (const o of activeFood.slice(0, 2)) lines.push(activeLine(o));
      if (activeFood[0]) chips.push(chip(`Track my ${activeFood[0].title} order`, "Where's my food order? Show its live status."));
      if (usual && usualDish) {
        chips.push(
          chip(
            `Reorder ${usualDish} from ${usual.name}`,
            `Reorder my usual from ${usual.name}: ${usualDish}. Find it on their menu and propose it for my cart (don't place the order).`,
          ),
        );
      } else if (lastFood) {
        chips.push(chip(`Order again from ${lastFood.title}`, `Show me the menu at ${lastFood.title}${lastFood.restaurantId ? ` (restaurantId ${lastFood.restaurantId})` : ""}.`));
      }
      chips.push(SLOT_FOOD[slot]);
      if (topDish && !chips.some((c) => c.label.includes(topDish))) chips.push(chip(`Best ${topDish} near me`));
      chips.push(chip("Something new I haven't tried", "Suggest a top-rated dish near me from a restaurant I haven't ordered from"));
      if (usual) {
        headline = `${usual.name} is your go-to — ${usual.count} of your last ${food.length} orders${usualDish ? `, usually ${usualDish}` : ""}.`;
      } else if (lastFood) {
        headline = `Your last order was from ${lastFood.title}${lastFood.placedAt ? ` (${lastFood.placedAt})` : ""}.`;
      }
      break;
    }
    case "instamart": {
      for (const o of activeIm.slice(0, 2)) lines.push(activeLine(o));
      if (activeIm[0]) chips.push(chip("Track my Instamart order", "Where's my Instamart order? Show its live status."));
      const staple = ins.topItems[0];
      if (staple && staple.count >= 2) chips.push(chip(`Restock ${staple.name}`, `Add ${staple.name} again — find the same product and propose it`));
      chips.push(chip("Refill my usuals", "Show my usual Instamart items so I can restock"));
      chips.push(SLOT_IM[slot]);
      chips.push(chip("Best deals today", "Best deals and discounts on Instamart today"));
      if (lastIm) {
        const t = parseOrderTime(lastIm.placedAt, nowMs);
        headline = `Your last Instamart order${t ? ` (${t.label})` : ""}: ${lastIm.items || lastIm.title}${lastIm.total ? `, ${lastIm.total}` : ""}.`;
      } else if (input.instamart) {
        headline = "No Instamart orders in the last 15 days — your usuals are below.";
      }
      break;
    }
    case "dineout": {
      const live = liveBookings(input.bookings, ["dineout"]);
      for (const b of live.slice(0, 2)) lines.push(bookingLine(b));
      if (live.length) chips.push(chip("Is my table confirmed?"));
      chips.push(
        slot === "breakfast" || slot === "lunch"
          ? chip(weekendSoon ? "Brunch spots this weekend" : "Lunch buffet near me")
          : chip(slot === "late-night" ? "Book a table for tomorrow night" : "Book a table for 2 tonight"),
      );
      if (topDish) chips.push(chip(`Dine-in ${topDish} places`, `Best restaurants for ${topDish} to dine in near me`));
      chips.push(chip("Rooftop places with offers", "Rooftop restaurants near me with the best dining offers"));
      chips.push(chip("Family-friendly restaurants"));
      headline = live.length
        ? `You have ${live.length} upcoming table booking${live.length === 1 ? "" : "s"} made here.`
        : topDish
          ? `You order a lot of ${topDish} — want to dine out for it?`
          : "";
      break;
    }
    case "scenes": {
      const live = liveBookings(input.bookings, ["scenes"]);
      for (const b of live.slice(0, 2)) lines.push(bookingLine(b));
      if (live.length) chips.push(chip("Is my ticket confirmed?", "Is my event booking confirmed?"));
      chips.push(hour < 20 ? chip("Something to do tonight", "Events happening tonight near me") : chip("Events tomorrow", "Events happening tomorrow near me"));
      chips.push(chip(weekendSoon ? "Comedy shows this weekend" : "Comedy shows this week"));
      chips.push(chip(weekendSoon ? "Live music this weekend" : "Live music this week"));
      headline = live.length ? `You have ${live.length} event booking${live.length === 1 ? "" : "s"} made here.` : "";
      break;
    }
    case "plan": {
      for (const o of [...activeFood, ...activeIm].slice(0, 2)) lines.push(activeLine(o));
      const live = liveBookings(input.bookings, ["dineout", "scenes"]);
      for (const b of live.slice(0, 2)) lines.push(bookingLine(b));
      const when = hour < 16 ? "this evening" : "tomorrow evening";
      chips.push(chip(`Plan ${when}: show + dinner out for 2`, `Plan ${when} for 2 near me: a show, then dinner out, snacks for the way home`));
      chips.push(
        weekendSoon
          ? chip("Family Saturday outing for 4", "Plan a Saturday outing for a family of 4 near me: a kids-friendly event, lunch out, and snacks")
          : chip("Date night: comedy + dinner", "Plan a date night this week: a comedy show and a nice dinner out, dessert delivered home after"),
      );
      chips.push(
        usual && usualDish
          ? chip(`Movie night in + ${usualDish}`, `Plan a night in for 2 tonight: ${usualDish} from ${usual.name} delivered and movie snacks from Instamart`)
          : chip("Night in: dinner + snacks", "Plan a night in for 2 tonight: dinner delivered and movie snacks from Instamart"),
      );
      headline = live.length || lines.length ? "Here's what's already lined up." : "";
      break;
    }
  }

  const uniq: BriefingChip[] = [];
  for (const c of chips) if (!uniq.some((u) => u.label === c.label)) uniq.push(c);
  const facts = [
    `Time of day: ${greeting.toLowerCase()} (${slot} time)`,
    ...(headline ? [headline] : []),
    ...lines,
  ];
  return {
    service,
    greeting,
    slot,
    headline,
    lines,
    chips: uniq.slice(0, 3),
    facts,
    hasData: !!headline || lines.length > 0,
  };
}
