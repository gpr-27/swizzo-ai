// POST /api/instamart/note — one short AI note for the Instamart tab
// (usuals briefing on open, cart review after a change). Body:
// { kind: "briefing" | "review", facts: string[] } where every fact was
// computed client-side from Swiggy's real responses. Returns { text, model }
// or { text: null } (the UI then keeps its deterministic line). No Swiggy calls.

import { instamartNote, type InstamartNoteKind } from "@/backend/agent/instamart-ai";
import { route } from "@/backend/http/route";
import { InstamartNoteBody } from "@/backend/http/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const KINDS = new Set<InstamartNoteKind>(["briefing", "review"]);

export const POST = route({ name: "api/instamart/note", rateLimit: "ai", body: InstamartNoteBody }, async function POST(request: Request): Promise<Response> {
  let body: { kind?: string; facts?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ text: null }, { status: 400 });
  }
  const kind = body.kind as InstamartNoteKind;
  const facts = Array.isArray(body.facts) ? body.facts.filter((f): f is string => typeof f === "string") : [];
  if (!KINDS.has(kind) || !facts.length) return Response.json({ text: null }, { status: 400 });
  const note = await instamartNote(kind, facts, request.signal);
  return Response.json(note ?? { text: null });
});
