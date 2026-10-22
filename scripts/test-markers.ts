// Checks the reply-marker parser on representative model outputs.
// Run: npx tsx --tsconfig tsconfig.json scripts/test-markers.ts

import assert from "node:assert/strict";

import { emitAssistantText } from "@/backend/agent/agent";
import type { ChatStreamEvent } from "@/shared/types";

function run(text: string, service: "instamart" | "food" = "instamart", user = ""): ChatStreamEvent[] {
  return [...emitAssistantText(text, service, new Map(), new Map(), user)];
}

const textOf = (evs: ChatStreamEvent[]) =>
  evs.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("");

// STEPS block with timers, then suggestions.
{
  const evs = run(
    "Let's cook!\nSTEPS:\n1. Rinse the rice (90s)\n2. Boil water (8m)\n- Simmer gently (20 min)\nServe hot\n\nSUGGESTIONS: Add ghee | Buy rice | Start timer",
  );
  const steps = evs.find((e) => e.type === "steps") as Extract<ChatStreamEvent, { type: "steps" }>;
  assert.ok(steps, "steps event");
  assert.deepEqual(
    steps.steps.map((s) => [s.text, s.seconds]),
    [
      ["Rinse the rice", 90],
      ["Boil water", 480],
      ["Simmer gently", 1200],
      ["Serve hot", undefined],
    ],
  );
  assert.equal(textOf(evs), "Let's cook!");
  const chips = evs.find((e) => e.type === "chips") as Extract<ChatStreamEvent, { type: "chips" }>;
  assert.deepEqual(chips.items, ["Add ghee", "Buy rice", "Start timer"]);
}

// Two SUGGESTIONS lines: both stripped, the last wins.
{
  const evs = run("Here you go.\nSUGGESTIONS: a | b\nMore text\nSUGGESTIONS: c | d");
  assert.equal(textOf(evs), "Here you go.\n\nMore text");
  const chips = evs.find((e) => e.type === "chips") as Extract<ChatStreamEvent, { type: "chips" }>;
  assert.deepEqual(chips.items, ["c", "d"]);
}

// Bold markers are parsed, not shown.
{
  const evs = run("**BEST:** TYF3262KU8 — best value\n**HEALTHY:** ABC123 — high protein\nAmul wins on price.");
  assert.equal(textOf(evs), "Amul wins on price.");
  assert.ok(evs.some((e) => e.type === "bestPick" && e.id === "TYF3262KU8"));
  assert.ok(evs.some((e) => e.type === "healthyPick" && e.id === "ABC123"));
}

// "order" in the user's message never auto-adds an item without an ADD marker.
{
  const evs = run("Here are some options.", "instamart", "what should I order for dinner?");
  assert.ok(!evs.some((e) => e.type === "addToCart"), "no auto-add");
}

console.log("marker parser: all checks passed");
