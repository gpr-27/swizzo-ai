// Short AI notes for the Instamart tab that don't need a tool loop: the usuals
// briefing on tab open, the cart review after a cart change, and the line on a
// refill basket. One generateText call down the same provider chain as chat
// (providers.ts), fed ONLY facts computed from Swiggy's real data; on any
// failure the caller keeps its deterministic text (never an invented one).

import { generateText } from "ai";

import { providerChain, isKeyRejected } from "./providers";
import { fenceUntrusted, UNTRUSTED_DATA_RULE } from "@/backend/security/prompt-guard";

export type InstamartNoteKind = "briefing" | "review" | "basket";

const SYSTEM: Record<InstamartNoteKind, string> = {
  briefing:
    "You are Swizzo, a grocery concierge on Swiggy Instamart. Write a warm 1-2 sentence briefing (max 40 words) for a user opening the grocery tab, from the FACTS only: what they usually buy (name 3-4 items), when they last ordered if known, anything out of stock or due. End by suggesting one tap: \"Refill my usuals\". Never invent items, dates, prices or offers. Plain text, no markdown, no lists.",
  review:
    "You are Swizzo, a grocery concierge on Swiggy Instamart. Write ONE or TWO short sentences (max 45 words) reviewing the user's cart from the FACTS only: the most important thing first (a blocker like unavailable items or the ₹99 minimum, then budget, then savings, stores, Swiggy One perks). Be concrete with the rupee figures given. Never invent prices, offers, coupons or items. Plain text, no markdown.",
  basket:
    "You are Swizzo, a grocery concierge on Swiggy Instamart. Write ONE sentence (max 35 words) introducing a refill basket from the FACTS only: item count, total vs budget, and any substitute or sponsored pick. Never invent anything. Plain text.",
};

const ATTEMPT_MS = 9_000;

/** One short note, or null when every provider failed / none is configured. */
export async function instamartNote(
  kind: InstamartNoteKind,
  facts: string[],
  signal?: AbortSignal,
): Promise<{ text: string; model: string } | null> {
  const clean = facts.map((f) => f.replace(/\s+/g, " ").trim().slice(0, 240)).filter(Boolean).slice(0, 24);
  if (!clean.length) return null;
  const rejected = new Set<string>();
  for (const attempt of providerChain(process.env).slice(0, 4)) {
    const key = `${attempt.provider}#${attempt.keyIndex}`;
    if (rejected.has(key) || signal?.aborted) continue;
    try {
      const res = await generateText({
        model: attempt.languageModel,
        instructions: SYSTEM[kind],
        prompt: `FACTS:\n${fenceUntrusted(`- ${clean.join("\n- ")}`)}${UNTRUSTED_DATA_RULE}`,
        maxOutputTokens: 400,
        maxRetries: 0,
        abortSignal: signal ? AbortSignal.any([signal, AbortSignal.timeout(ATTEMPT_MS)]) : AbortSignal.timeout(ATTEMPT_MS),
        providerOptions: attempt.providerOptions as never,
      });
      const text = res.text.replace(/\s+/g, " ").trim();
      if (text) return { text: text.slice(0, 400), model: attempt.model.label };
    } catch (err) {
      if (isKeyRejected(err)) rejected.add(key);
    }
  }
  return null;
}
