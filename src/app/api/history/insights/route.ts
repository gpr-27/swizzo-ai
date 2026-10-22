// POST /api/history/insights { facts: string[] } → { ok, text?, model? }
// The History page's AI summary: one model call (no tools, ~4 s budget,
// cached by fact list) that rephrases the page's REAL insight facts
// (src/backend/history/insights.ts → insightFacts) into 1-2 sentences. Any
// number the model writes must already be in the facts, else `text` is absent
// and the page keeps its deterministic headline. Calls no Swiggy tool.

import { aiPhrase } from "@/backend/briefing/ai-phrase";
import { route } from "@/backend/http/route";
import { HistoryInsightsBody } from "@/backend/http/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = route({ name: "api/history/insights", rateLimit: "ai", body: HistoryInsightsBody }, async function POST(request: Request): Promise<Response> {
  let body: { facts?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ ok: false, message: "Invalid JSON body." }, { status: 400 });
  }
  const facts = (Array.isArray(body.facts) ? body.facts : [])
    .filter((f): f is string => typeof f === "string" && f.trim().length > 0)
    .map((f) => f.slice(0, 240))
    .slice(0, 12);
  if (!facts.length) return Response.json({ ok: true });
  const phrase = await aiPhrase({
    task: "Summarise this person's recent Swiggy orders and bookings in 1-2 short sentences (max 230 characters): spend, their go-to place or dish, when they usually order, and anything active right now.",
    facts,
    maxChars: 260,
  }).catch(() => null);
  return Response.json(phrase ? { ok: true, text: phrase.text, model: phrase.model } : { ok: true });
});
