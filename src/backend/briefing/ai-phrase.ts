// One short AI-written sentence (or two) from a list of REAL facts — used by the
// per-tab home briefing and the History page's AI summary. The model only
// rephrases what it is given: every number in its answer must already appear
// in the facts (else the deterministic text is used), it gets no tools, and it
// has a hard time budget so the UI never waits on it. Results are cached by
// fact list, so re-opening a tab costs no extra model call.

import { generateText } from "ai";
import { createHash } from "node:crypto";
import { isKeyRejected, providerChain } from "@/backend/agent/providers";
import type { GeneratedBy } from "@/shared/types";
import { fenceUntrusted, UNTRUSTED_DATA_RULE } from "@/backend/security/prompt-guard";

export interface AiPhrase {
  text: string;
  model: GeneratedBy;
}

const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 200;
const cache = new Map<string, { at: number; value: AiPhrase | null }>();

/** Every number written in `s` ("₹1,234" → "1234", "7:35" → "7", "35"). */
export function numbersIn(s: string): string[] {
  return (s.replace(/(\d),(?=\d)/g, "$1").match(/\d+(?:\.\d+)?/g) ?? []).map((n) => String(Number(n)));
}

/** True when every number in `text` also appears somewhere in `facts`. */
export function numbersGrounded(text: string, facts: string[]): boolean {
  const known = new Set(numbersIn(facts.join(" \n ")));
  return numbersIn(text).every((n) => known.has(n));
}

/** Trim + reject anything that isn't a short plain sentence built from the facts. */
export function acceptPhrase(raw: string, facts: string[], maxChars: number): string | null {
  const text = raw
    .replace(/^["'`\s]+|["'`\s]+$/g, "")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text || text.length > maxChars) return null;
  // marker / markdown / list leakage, or the model talking about itself
  if (/^(?:[-*#>]|\d+\.)|\b(?:ADD|PICK|SUGGESTIONS|ITINERARY):|as an ai|i (?:can(?:no|')t|don't have)/i.test(text)) return null;
  return numbersGrounded(text, facts) ? text : null;
}

function cacheKey(task: string, facts: string[]): string {
  return createHash("sha256").update(task).update("\0").update(facts.join("\n")).digest("hex").slice(0, 24);
}

/**
 * Ask the provider chain for a short phrasing of `facts`. Returns null on any
 * failure, timeout, or ungrounded answer — callers keep their own text then.
 */
export async function aiPhrase(opts: {
  task: string;
  facts: string[];
  maxChars?: number;
  timeoutMs?: number;
}): Promise<AiPhrase | null> {
  const facts = opts.facts.map((f) => f.trim()).filter(Boolean).slice(0, 16);
  if (!facts.length) return null;
  const maxChars = opts.maxChars ?? 240;
  const key = cacheKey(opts.task, facts);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const deadline = Date.now() + (opts.timeoutMs ?? 4_500);
  const rejected = new Set<string>();
  let value: AiPhrase | null = null;
  let tries = 0;
  for (const attempt of providerChain(process.env)) {
    const remaining = deadline - Date.now();
    if (remaining < 800 || tries >= 3) break;
    const keyId = `${attempt.provider}#${attempt.keyIndex}`;
    if (rejected.has(keyId)) continue;
    tries++;
    try {
      const res = await generateText({
        model: attempt.languageModel,
        instructions:
          "You write the one-glance briefing line of a Swiggy concierge app. Use ONLY the facts given — never add a number, price, time, distance, name or status that is not in them, and never promise anything. Warm, specific, second person, no greeting, no emoji, no markdown, no lists. Reply with the sentence(s) only.",
        prompt: `${opts.task}\n\nFACTS:\n${fenceUntrusted(facts.map((f) => `- ${f}`).join("\n"))}${UNTRUSTED_DATA_RULE}`,
        maxOutputTokens: 400,
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(remaining),
        providerOptions: attempt.providerOptions as never,
      });
      const text = acceptPhrase(res.text, facts, maxChars);
      if (text) {
        value = {
          text,
          model: {
            provider: attempt.provider,
            model: attempt.model.id,
            label: attempt.model.label,
            step: attempt.stepLabel,
            fallbacks: tries - 1,
          },
        };
        break;
      }
    } catch (err) {
      if (isKeyRejected(err)) rejected.add(keyId);
    }
  }
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}
