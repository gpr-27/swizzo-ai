// POST /api/ai-read — a short, tool-free AI read of data the client ALREADY
// loaded from Swiggy (a Dineout restaurant's details, a Scenes event listing, a
// Dineout compare). No Swiggy call is made here (Dineout is rate-limited; the
// loaded data is reused), and the model may only restate the facts it is given.
//   body: { kind: "dineout" | "scenes" | "compare", facts: string, needs?: string }
//   →     { ok: true, summary?, fit?, verdict?, model } | { ok: false, message }
// Walks the same provider chain as the chat (Claude Haiku → Groq ×2 → Gemini ×2).

import { generateText } from "ai";
import { isKeyRejected, providerChain } from "@/backend/agent/providers";
import { parseAiRead } from "@/shared/aiRead";
import { route } from "@/backend/http/route";
import { AiReadBody } from "@/backend/http/schemas";
import { fenceUntrusted, UNTRUSTED_DATA_RULE } from "@/backend/security/prompt-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 40;

const KINDS = new Set(["dineout", "scenes", "compare"]);
const BUDGET_MS = 25_000;
const STEP_MS = 12_000;

const RULES = `You are Swizzo, a sharp Swiggy concierge. You get FACTS that Swiggy returned (real data) and, maybe, the USER'S NEEDS in their own words.
Rules:
- Use ONLY the facts. Never invent a dish, vibe, crowd, price, offer, rating, seat count or time that is not in the facts.
- Swiggy gives star ratings and the NUMBER of ratings only — there is NO review text. Never quote, paraphrase or invent reviews or what "people say"; cite the rating and its count instead.
- Plain English, no markdown, no emojis, no lists.`;

function promptFor(kind: string): string {
  if (kind === "compare") {
    return `${RULES}
Write exactly one line:
VERDICT: <≤35 words: who wins on what (rating with its count, value = cost for two + % off, distance, booking) and which one to pick for the user's needs if given>`;
  }
  const what = kind === "scenes" ? "event" : "restaurant";
  return `${RULES}
Write exactly two lines:
SUMMARY: <≤40 words: the most useful facts about this ${what} for deciding${kind === "scenes" ? " (seating, duration, age, language, distance, dates, price range, seats left, offer)" : " (rating + count, cost, open hours, best deal and its cover charge, standout amenities or perks, distance)"}>
FIT: <start with "Yes —", "Maybe —" or "Probably not —", then ≤25 words on whether it suits the user's needs, naming the facts that decide it; with no needs given, judge it for a typical evening out>`;
}

export const POST = route({ name: "api/ai-read", rateLimit: "ai", body: AiReadBody }, async function POST(request: Request): Promise<Response> {
  let body: { kind?: unknown; facts?: unknown; needs?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, message: "Invalid JSON body" }, { status: 400 });
  }
  const kind = typeof body.kind === "string" && KINDS.has(body.kind) ? body.kind : "";
  const facts = typeof body.facts === "string" ? body.facts.trim().slice(0, 4000) : "";
  const needs = typeof body.needs === "string" ? body.needs.trim().slice(0, 600) : "";
  if (!kind || !facts) return Response.json({ ok: false, message: "kind and facts are required" }, { status: 400 });

  const attempts = providerChain(process.env);
  if (!attempts.length) return Response.json({ ok: false, message: "No AI provider is configured" }, { status: 503 });

  const deadline = Date.now() + BUDGET_MS;
  const rejected = new Set<string>();
  for (const a of attempts) {
    const keyId = `${a.provider}#${a.keyIndex}`;
    if (rejected.has(keyId)) continue;
    const left = deadline - Date.now();
    if (left < 2_000) break;
    try {
      const res = await generateText({
        model: a.languageModel,
        instructions: promptFor(kind) + UNTRUSTED_DATA_RULE,
        prompt: `FACTS (from Swiggy):\n${fenceUntrusted(facts)}\n\nUSER'S NEEDS: ${needs ? fenceUntrusted(needs) : "(none stated)"}`,
        maxRetries: 0,
        maxOutputTokens: 600,
        abortSignal: AbortSignal.timeout(Math.min(STEP_MS, left)),
        providerOptions: a.providerOptions as never,
      });
      const parsed = parseAiRead(res.text ?? "");
      if (!parsed.summary && !parsed.fit && !parsed.verdict) throw new Error("unparseable AI read");
      return Response.json({ ok: true, ...parsed, model: a.model.label });
    } catch (err) {
      if (isKeyRejected(err)) rejected.add(keyId);
    }
  }
  return Response.json({ ok: false, message: "The AI read is unavailable right now" }, { status: 502 });
});
