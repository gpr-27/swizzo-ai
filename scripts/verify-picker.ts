// Chat ↔ open picker: PICK / WHY marker parsing, the picker matching logic
// (date / time / ticket-name resolution, counts, ambiguity, "not offered"),
// the deterministic text fallback, the AI-picks ranking, the confirm flag and
// the server guard that keeps an open picker from being swapped silently.
// Run: npx tsx --tsconfig tsconfig.json scripts/verify-picker.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { emitAssistantText } from "@/backend/agent/agent";
import { eventAllowedFor } from "@/backend/agent/runner";
import { mapShowListing } from "@/backend/mcp/scenes-mcp";
import {
  blocksOtherPicker,
  buildDineoutActivePicker,
  buildScenesActivePicker,
  describeActivePicker,
  extractPickMarkers,
  parseClock,
  oneTapPick,
  parsePickBody,
  pickFromUserText,
  pickerToolNote,
  quickRead,
  rankDineoutPicks,
  rankScenesPicks,
  resolveDineoutPick,
  resolveScenesPick,
  sanitizeActivePicker,
} from "@/shared/picker";
import { registerPicker, sendBestPick } from "@/frontend/utils/pickerBridge";
import type { ChatStreamEvent, DineoutDeal, DineoutSlot, ScenesShow, ScenesShowListing } from "@/shared/types";

let passes = 0;
let failures = 0;
function check(ok: unknown, label: string) {
  if (ok) {
    passes++;
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.log(`  ✗ ${label}`);
  }
}

// "Now" = Thu 22 Oct 2026, 12:00 IST.
const NOW = Date.UTC(2026, 9, 22, 6, 30);
const unix = (y: number, mo: number, d: number, h: number, mi = 0) => Date.UTC(y, mo - 1, d, h - 5, mi - 30) / 1000;

/* ------------------------- the bug's comedy listing ------------------------ */
const tickets = (showId: string) => [
  { ticketId: `${showId}-1`, title: "Entry Pass For One", price: 199, availableInventory: 40, onSale: true },
  { ticketId: `${showId}-2`, title: "Entry Pass For Two", price: 349, availableInventory: 20, onSale: true },
];
const show = (showId: string, d: number, h: number, mi = 0, seats = 60, label?: string): ScenesShow => ({
  showId,
  showTimeIst: `${label ?? ""}, ${d} Oct, ${((h + 11) % 12) + 1}:${String(mi).padStart(2, "0")} ${h >= 12 ? "pm" : "am"}`,
  showTimeUnix: unix(2026, 10, d, h, mi),
  date: `2026-10-${d}`,
  availableSeats: seats,
  minGuests: 1,
  maxGuests: 10,
  onSale: true,
  tickets: tickets(showId),
});
const comedy: ScenesShowListing = {
  eventId: "100109009",
  eventTitle: "Standup Comedy Show Bangalore",
  venueId: "1233",
  venueName: "The Comedy Theatre",
  latitude: 12.97,
  longitude: 77.59,
  shows: [
    show("5001", 23, 21, 0, 60, "Fri"),
    show("5002", 24, 19, 0, 60, "Sat"),
    show("5003", 24, 21, 30, 4, "Sat"),
    show("5004", 25, 21, 0, 60, "Sun"),
    show("5005", 30, 21, 0, 60, "Fri"),
    show("5006", 31, 21, 0, 60, "Sat"),
  ],
};
const scenesAp = buildScenesActivePicker("msg-sc", comedy, { date: "2026-10-23", showId: "5001", ticketId: "5001-1", qty: 1 });

console.log("\n# PICK / WHY markers");
{
  const p = parsePickBody("date=2026-10-25 | time=9:00 PM | ticket=Entry Pass For Two | qty=1 | confirm=1");
  check(p.date === "2026-10-25" && p.time === "9:00 PM" && p.ticketName === "Entry Pass For Two" && p.qty === 1, "parsePickBody: all fields");
  check(p.confirm === true, "parsePickBody: confirm=1 → confirm");
  check(parsePickBody("ticket=1217598 | time=100492730").ticketId === "1217598", "numeric ticket → ticketId");
  check(parsePickBody("time=100492730").showId === "100492730", "numeric time → showId");
  check(parsePickBody("date=- | qty=two").qty === 2 && parsePickBody("date=-").date === undefined, "placeholder dropped, word count");
  check(parsePickBody("guests=4 | deal=free | confirm=no").confirm === undefined, "confirm=no → no confirm");
  const ex = extractPickMarkers("**PICK:** date=2026-10-25 | ticket=Entry Pass For Two\nSet to Sun 25 Oct.");
  check(ex.picks.length === 1 && !ex.rest.includes("PICK"), "bold PICK line parsed + stripped");

  const evs = [
    ...emitAssistantText(
      "PICK: date=2026-10-25 | time=9:00 pm | ticket=Entry Pass For Two | qty=1\nWHY: value — cheapest per person\nSet to Sun 25 Oct · 9:00 PM · Entry Pass For Two — tap Review to confirm.\nSUGGESTIONS: Review | 2 passes | Saturday",
      "scenes",
      new Map(),
      new Map(),
      "",
      { kind: "scenes", messageId: "msg-sc" },
    ),
  ];
  const sel = evs.find((e) => e.type === "pickerSelect") as Extract<ChatStreamEvent, { type: "pickerSelect" }>;
  check(sel?.target === "scenes" && sel.messageId === "msg-sc" && sel.ticketName === "Entry Pass For Two", "emitAssistantText → pickerSelect");
  const why = evs.find((e) => e.type === "pickerReasons") as Extract<ChatStreamEvent, { type: "pickerReasons" }>;
  check(why?.reasons[0]?.id === "value" && why.reasons[0].why === "cheapest per person", "WHY → pickerReasons");
  const text = evs.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("");
  check(text === "Set to Sun 25 Oct · 9:00 PM · Entry Pass For Two — tap Review to confirm.", "marker lines stripped from prose");
  check(eventAllowedFor("scenes", sel) && eventAllowedFor("plan", sel) && !eventAllowedFor("dineout", sel), "pickerSelect domain guard");
  const planEvs = [...emitAssistantText("PICK: guests=4 | deal=free", "plan", new Map(), new Map(), "")];
  check((planEvs.find((e) => e.type === "pickerSelect") as { target?: string })?.target === "dineout", "plan: target inferred from fields");
}

console.log("\n# Scenes matching (the bug)");
{
  const msg = "I want you to select the date for 25 October for an entry pass for two.";
  const sel = pickFromUserText(msg, scenesAp, NOW);
  check(sel?.date === "2026-10-25", `fallback: date 25 October → 2026-10-25 (${sel?.date})`);
  check(sel?.ticketName === "Entry Pass For Two", `fallback: ticket "Entry Pass For Two" (${sel?.ticketName})`);
  check(sel?.qty === 1, `fallback: qty 1 — one pass for two (${sel?.qty})`);
  check(!sel?.confirm, "fallback: 'select' is not a booking request");
  const r = resolveScenesPick(comedy, sel!, { date: "2026-10-23", defaultShowId: "5001" }, NOW);
  check(r.date === "2026-10-25" && r.showId === "5004" && r.ticketId === "5004-2" && r.qty === 1, "resolve: Sun 25 Oct · 9 pm · For Two · 1");
  check(r.notes.length === 0 && !r.awaitShow, "resolve: no notes, no ambiguity");

  const amb = resolveScenesPick(comedy, { date: "2026-10-24", ticketName: "entry pass for 2" }, { date: "2026-10-23" }, NOW);
  check(amb.awaitShow === true && amb.showId === undefined, "date with 2 shows → no show chosen (awaits a tap)");
  check(amb.pendingTicket === "entry pass for 2" && /7:00 pm, 9:30 pm/.test(amb.notes[0] ?? ""), "pending ticket kept + show times in the note");
  const timed = resolveScenesPick(comedy, { time: "9:30 PM" }, { date: "2026-10-24" }, NOW);
  check(timed.showId === "5003" && timed.date === "2026-10-24", "time chip on the current date → that show");
  const byId = resolveScenesPick(comedy, { showId: "5006" }, {}, NOW);
  check(byId.date === "2026-10-31" && byId.showId === "5006", "showId alone → its date");
  const off = resolveScenesPick(comedy, { date: "2026-10-26" }, { date: "2026-10-23" }, NOW);
  check(off.date === undefined && /isn't available/.test(off.notes[0] ?? ""), "date not offered → note, nothing changed");
  const offText = pickFromUserText("the 26th please", scenesAp, NOW);
  check(!!offText && /isn't available/.test(resolveScenesPick(comedy, offText, {}, NOW).notes[0] ?? ""), "'the 26th' → not-offered note");
  const qtyOnly = resolveScenesPick(comedy, { qty: 3 }, { date: "2026-10-23", showId: "5001" }, NOW);
  check(qtyOnly.showId === "5001" && qtyOnly.qty === 3 && !qtyOnly.awaitShow, "count only → stays on the current show");
  const clamp = resolveScenesPick(comedy, { date: "2026-10-24", time: "9:30 pm", qty: 9 }, {}, NOW);
  check(clamp.qty === 4 && clamp.notes.some((n) => /Only 4/.test(n)), "qty clamped to seats left + note");
  check(pickFromUserText("2 tickets for sunday", scenesAp, NOW)?.qty === 2, "'2 tickets' → qty 2");
  const four = pickFromUserText("entry pass for two on the 30th for 4 people", scenesAp, NOW);
  check(four?.qty === 2 && four.date === "2026-10-30", "'for 4 people' with a for-two pass → 2 passes");
  check(pickFromUserText("book 2 entry passes for two on the 25th", scenesAp, NOW)?.confirm === true, "'book …' → confirm");
  check(pickFromUserText("show me other comedy events", scenesAp, NOW) === null, "unrelated message → no fallback pick");
  check(parseClock("Sat, 24 Oct, 9:30 pm") === 21 * 60 + 30 && parseClock("21:00") === 1260 && parseClock("8 pm") === 1200, "parseClock");
}

console.log("\n# Real listing fixture (tiers differ per show)");
{
  const raw = JSON.parse(readFileSync(join(__dirname, "fixtures/scenes/shows_100081309_live.json"), "utf8"));
  const live = mapShowListing(raw, { eventId: "100081309", venueId: "1084", latitude: 12.93, longitude: 77.61 });
  const ap = buildScenesActivePicker("m-live", live, {});
  const four = ap.tickets.find((t) => t.name === "Entry Pass For 4");
  check(!!four && four.onlyOn?.length === 1 && four.onlyOn[0] === "2026-10-24", "snapshot: tier sold only on some dates → onlyOn");
  const r = resolveScenesPick(live, { date: "2026-10-31", ticketName: "Entry Pass For 4" }, {}, NOW);
  check(r.ticketId === undefined && /isn't offered/.test(r.notes.join(" ")), "tier not sold that day → inline note, not a guess");
  const r2 = resolveScenesPick(live, { date: "2026-10-24", time: "2:00 pm", ticketName: "pass for two" }, {}, NOW);
  check(r2.showId === "100492730" && r2.ticketId === "1217598", "'pass for two' ↔ 'Entry Pass For 2'");
  check(describeActivePicker(ap).includes("TICKET PICKER") && describeActivePicker(ap).includes("2026-10-24"), "describeActivePicker");
}

/* ------------------------------ Dineout picker ----------------------------- */
const deal = (slotId: number, item: string, free: boolean, disc?: number, soldOut = false): DineoutDeal => ({
  itemId: `r1-${item}`,
  ticketId: item,
  slotId,
  title: free ? "Table reservation" : "Flat 15% off on pre-booking",
  isFree: free,
  bookingPrice: free ? undefined : 100,
  discountPercentage: disc,
  soldOut,
});
const slot = (date: string, time: string, h: number, mi: number, group: string, deals: DineoutDeal[], inv?: number): DineoutSlot => ({
  key: `${date}|${time}`,
  slotId: deals[0]?.slotId ?? 1,
  dateStr: date,
  displayTime: time,
  reservationTime: unix(Number(date.slice(0, 4)), Number(date.slice(5, 7)), Number(date.slice(8)), h, mi),
  slotGroupName: group,
  availableInventory: inv,
  subText: deals.some((d) => d.discountPercentage) ? "15% off" : undefined,
  deals,
});
// Ganbeii-like: tonight only late dinner (paid 15% off); tomorrow wide open with free tables.
const slots: DineoutSlot[] = [
  slot("2026-10-22", "10:15 PM", 22, 15, "Dinner", [deal(1, "p", false, 15)]),
  slot("2026-10-22", "10:45 PM", 22, 45, "Dinner", [deal(1, "p", false, 15)]),
  slot("2026-10-23", "12:30 PM", 12, 30, "Lunch", [deal(1, "f", true), deal(1, "p", false, 15)]),
  slot("2026-10-23", "07:30 PM", 19, 30, "Dinner", [deal(1, "f", true), deal(1, "p", false, 15)]),
  slot("2026-10-23", "08:00 PM", 20, 0, "Dinner", [deal(1, "f", true), deal(1, "p", false, 15)]),
  slot("2026-10-23", "08:30 PM", 20, 30, "Dinner", [deal(1, "p", false, 15)]),
  slot("2026-10-23", "09:00 PM", 21, 0, "Dinner", [deal(1, "f", true)], 0),
  slot("2026-10-24", "08:30 PM", 20, 30, "Dinner", [deal(1, "f", true), deal(1, "p", false, 15)]),
];
const doAp = buildDineoutActivePicker("msg-do", { restaurantId: "r1", restaurantName: "Ganbeii" }, slots, { date: "2026-10-22", guests: 2 });

console.log("\n# Dineout matching");
{
  const sel = pickFromUserText("book tomorrow 8 pm for 4, free table", doAp, NOW);
  check(sel?.date === "2026-10-23" && sel.time === "8:00 pm" && sel.guests === 4 && sel.deal === "free" && sel.confirm, "fallback: tomorrow 8 pm for 4 free + confirm");
  const r = resolveDineoutPick(slots, sel!, { date: "2026-10-22" }, NOW);
  check(r.key === "2026-10-23|08:00 PM" && r.itemId === "r1-f" && r.guests === 4 && r.notes.length === 0, "resolve: slot + free deal + guests");
  const paid = resolveDineoutPick(slots, { date: "2026-10-23", time: "8:30 PM", deal: "free" }, {}, NOW);
  check(paid.key === "2026-10-23|08:30 PM" && paid.itemId === "r1-p" && /No free reservation/.test(paid.notes[0] ?? ""), "free not offered at that time → note");
  const missing = resolveDineoutPick(slots, { date: "2026-10-23", time: "8:15 pm" }, {}, NOW);
  check(missing.key === undefined && /nearest open: 08:00 PM, 08:30 PM/.test(missing.notes[0] ?? ""), "time not offered → nearest open times");
  const full = resolveDineoutPick(slots, { date: "2026-10-23", time: "9 pm" }, {}, NOW);
  check(full.key === undefined && /fully booked/.test(full.notes[0] ?? ""), "full slot → note");
  const g = resolveDineoutPick(slots, { guests: 40 }, { date: "2026-10-23" }, NOW);
  check(g.guests === 20 && g.key === undefined, "guests clamped to 20, selection kept");
  check(pickFromUserText("for 4 people", doAp, NOW) === null, "bare count isn't a picker instruction");
  check(Object.keys(doAp.dates[1].meals).join() === "Lunch,Dinner" && !doAp.dates[1].meals.Dinner.includes("09:00 PM"), "snapshot: open times per meal (full slot omitted)");
}

console.log("\n# AI picks ranking");
{
  const picks = rankDineoutPicks(slots, { guests: 2, nowMs: NOW });
  const by = Object.fromEntries(picks.map((p) => [p.id, p]));
  check(picks.length === 3, `3 dineout picks (${picks.map((p) => p.id).join(", ")})`);
  check(by.soonest?.title === "Tonight 10:15 PM · ₹100 deal · 15% off", `soonest = tonight 10:15 PM (${by.soonest?.title})`);
  check(by.value?.sel.date === "2026-10-23" && by.value.sel.time === "08:00 PM" && by.value.sel.deal === "free", `best value = tomorrow 8 PM free (${by.value?.title})`);
  check(by.prime?.sel.date === "2026-10-24" && by.prime.sel.time === "08:30 PM", `prime time = Sat 8:30 PM (${by.prime?.title})`);
  check(picks.every((p) => p.sel.guests === 2), "picks carry the guest count");
  check(rankDineoutPicks(slots, { guests: 2, nowMs: Date.UTC(2026, 9, 30) }).length === 0, "no future slots → no picks (nothing invented)");

  const sp = rankScenesPicks(comedy, { nowMs: NOW });
  const sb = Object.fromEntries(sp.map((p) => [p.id, p]));
  check(sb.soonest?.sel.showId === "5001" && sb.soonest.sel.ticketName === "Entry Pass For One", `scenes soonest = Fri 9 pm · For One (${sb.soonest?.title})`);
  check(sb.value?.sel.ticketName === "Entry Pass For Two" && /₹175/.test(sb.value.why), `scenes value = For Two, ₹175/person (${sb.value?.why})`);
  check(sb.fast?.sel.showId === "5003", `selling fast = Sat 9:30 pm, 4 seats (${sb.fast?.title})`);
  check(scenesAp.aiPicks?.length === sp.length, "snapshot carries the AI picks");
  // "Book this" = the pick's full selection + confirm, resolved like a chat PICK
  const book = resolveScenesPick(comedy, { ...sb.value!.sel, confirm: true }, {}, NOW);
  check(book.showId === sb.value!.sel.showId && book.ticketId === sb.value!.sel.ticketId && book.qty === 1, "Book this → complete selection (ready for Review)");
  const note = pickerToolNote([{ type: "dineoutSlots", ...{ restaurantId: "r1", restaurantName: "G", latitude: 1, longitude: 1, slots } }], 2, NOW);
  check(note.includes("AI PICKS") && note.includes("WHY:"), "tool note asks the model for the read + WHY lines");
  check(/Ganbeii/.test(quickRead(doAp)) && /free tables/.test(quickRead(doAp)), `quick read from real data (${quickRead(doAp)})`);
}

console.log("\n# One-tap AI booking from results");
{
  const picks = rankDineoutPicks(slots, { guests: 2, nowMs: NOW });
  const d = oneTapPick("dineout", picks);
  check(d?.deal === "free" && d.confirm === true && d.date === "2026-10-23" && d.time === "08:00 PM", `dineout one-tap = free best value + confirm summary (${JSON.stringify(d)})`);
  const paidOnly = picks.map((p) => ({ ...p, sel: { ...p.sel, deal: "paid-item" } }));
  check(oneTapPick("dineout", paidOnly)?.confirm === undefined, "paid deal → selected only (no create_cart without a tap)");
  const sc = oneTapPick("scenes", rankScenesPicks(comedy, { nowMs: NOW }));
  check(!!sc?.showId && !!sc.ticketId && sc.confirm === undefined, "scenes one-tap = best show + ticket + qty, no cart (Review stays the user's)");
  check(oneTapPick("scenes", []) === null, "no picks → nothing selected");
  // bridge: a best-pick request waits for the picker to register, then applies its best()
  const applied: unknown[] = [];
  sendBestPick("msg-later");
  registerPicker("msg-later", { kind: "dineout", snapshot: () => null, apply: (x) => applied.push(x), best: () => d });
  // registerPicker applies queued work in a microtask → check on the next timer tick
  setTimeout(() => {
    check(applied.length === 1 && applied[0] === d, "sendBestPick before mount → applied on register");
    sendBestPick("msg-later");
    check(applied.length === 2, "sendBestPick on a mounted picker → applied now");
  }, 0);
}

console.log("\n# Guard + validation");
{
  const other = { type: "scenesShows", eventId: "999", eventTitle: "Comedy Night Koramangala" };
  check(blocksOtherPicker(other, scenesAp, "I want you to select the date for 25 October for an entry pass for two.", NOW) !== null, "bug message → other event's picker NOT opened");
  check(blocksOtherPicker(other, scenesAp, "comedy shows this weekend", NOW) !== null, "browsing → no picker swap");
  check(blocksOtherPicker(other, scenesAp, "show tickets for Comedy Night Koramangala", NOW) === null, "explicit 'show tickets for X' → allowed");
  check(blocksOtherPicker({ type: "scenesShows", eventId: "100109009" }, scenesAp, "anything", NOW) === null, "same event → allowed");
  check(blocksOtherPicker(other, undefined, "x", NOW) === null, "no open picker → allowed");

  const round = sanitizeActivePicker(JSON.parse(JSON.stringify(scenesAp)));
  check(round?.kind === "scenes" && round.dates.length === 5 && round.tickets.length === 2 && round.aiPicks?.length === 3, "sanitize: round trip");
  check(sanitizeActivePicker({ kind: "scenes", eventId: "1" }) === undefined, "sanitize: no messageId → dropped");
  check(sanitizeActivePicker({ kind: "food", messageId: "x" }) === undefined, "sanitize: unknown kind → dropped");
  const huge = { ...doAp, restaurantName: "x".repeat(5000) };
  check((sanitizeActivePicker(huge) as { restaurantName?: string })?.restaurantName?.length === 160, "sanitize: strings capped");
  const dRound = sanitizeActivePicker(JSON.parse(JSON.stringify(doAp)));
  check(dRound?.kind === "dineout" && dRound.guests === 2 && dRound.dates[0].meals.Dinner?.length === 2, "sanitize: dineout round trip");
}

// after the queued bridge checks above
setTimeout(() => {
  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures) process.exit(1);
}, 0);
