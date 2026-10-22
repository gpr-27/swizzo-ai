// POST /api/chat — streams the (service-aware) concierge reply as NDJSON, one
// ChatStreamEvent per line. The agent walks the LLM provider chain
// (Claude Haiku → Groq ×2 → Gemini ×2) and calls the service's read-only
// Swiggy MCP tools; a `model` event names whichever model answered.

import { runChat } from "@/backend/agent/agent";
import { classifyProviderError, formatErrorMarkdown } from "@/backend/agent/diagnostics";
import { scopeContext, type PromptContext } from "@/backend/agent/services";
import { DEFAULT_ADDRESS_ID, isAuthError } from "@/backend/config/env";
import { getAddresses } from "@/backend/mcp/swiggy-mcp";
import { sanitizeActivePicker } from "@/shared/picker";
import { isFollowUpQuestion } from "@/backend/agent/followUp";
import { SERVICES, type ChatRequest, type ChatStreamEvent, type Role, type Service } from "@/shared/types";
import { route } from "@/backend/http/route";
import { ChatBody } from "@/backend/http/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The provider chain budgets 100 s for a whole turn (see runner.ts).
export const maxDuration = 120;

// Bengaluru fallback when the client doesn't pass coordinates.
const DEFAULT_LAT = 12.9716;
const DEFAULT_LNG = 77.5946;

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
// ~5 MB of image bytes once base64-decoded.
const MAX_IMAGE_B64 = 7_000_000;

const encoder = new TextEncoder();

function line(event: ChatStreamEvent): Uint8Array {
  return encoder.encode(JSON.stringify(event) + "\n");
}

function ndjsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ type: "error", message }) + "\n", {
    status,
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
  });
}

function resolveService(value: unknown): Service {
  return typeof value === "string" && (SERVICES as string[]).includes(value)
    ? (value as Service)
    : "instamart";
}

/** Human-readable address line for the prompt; looked up only if the client didn't send one. */
async function resolveAddressLine(addressId: string, provided: unknown): Promise<string> {
  if (typeof provided === "string" && provided.trim()) return provided.trim().slice(0, 200);
  try {
    const found = (await getAddresses()).find((a) => a.id === addressId);
    if (found) return found.addressLine;
  } catch {
    // Not logged in / lookup failed — the agent can still run read-only searches.
  }
  return "the user's selected delivery address";
}

// Card events (Swiggy results drawn as cards). On a follow-up QUESTION about
// results already in the conversation ("which is best rated?", "is it open
// now?") the agent may still look things up, but nothing new is drawn — the
// answer is text. Cards only come when the user asks to SEE something.
const CARD_EVENTS = new Set<ChatStreamEvent["type"]>([
  "products",
  "suggestions",
  "foodRestaurants",
  "menu",
  "dishQuery",
  "dineoutRestaurants",
  "scenesEvents",
]);
export const POST = route({ name: "api/chat", rateLimit: "chat", body: ChatBody, maxBodyBytes: 8 * 1024 * 1024, ndjson: true }, async function POST(request: Request): Promise<Response> {
  let body: ChatRequest;
  try {
    body = (await request.json()) as ChatRequest;
  } catch {
    return ndjsonError("Invalid request body.", 400);
  }

  const service = resolveService(body.service);
  const message = typeof body.message === "string" ? body.message.slice(0, 4_000) : "";

  let image: { mediaType: string; data: string } | undefined;
  if (body.image && typeof body.image.data === "string") {
    if (!IMAGE_TYPES.has(body.image.mediaType)) {
      return ndjsonError("Please attach a JPEG, PNG, WebP or GIF photo.", 400);
    }
    if (body.image.data.length > MAX_IMAGE_B64) {
      return ndjsonError("That photo is too large — please use one under 5 MB.", 413);
    }
    image = { mediaType: body.image.mediaType, data: body.image.data };
  }

  // Fall back to the default address so searches work before the client's
  // address list has loaded.
  const addressId = (typeof body.addressId === "string" && body.addressId) || DEFAULT_ADDRESS_ID;
  const cartLines = Array.isArray(body.cartLines)
    ? body.cartLines
        .filter(
          (l): l is { id: string; name: string; quantity: number } =>
            l != null &&
            typeof l.id === "string" &&
            typeof l.name === "string" &&
            typeof l.quantity === "number",
        )
        .slice(0, 40)
    : undefined;
  const knownBookings = Array.isArray(body.knownBookings)
    ? body.knownBookings
        .filter(
          (b): b is { kind: "dineout" | "scenes"; orderId: string; title: string } =>
            b != null &&
            (b.kind === "dineout" || b.kind === "scenes") &&
            typeof b.orderId === "string" &&
            b.orderId.length > 0 &&
            b.orderId.length < 80 &&
            typeof b.title === "string",
        )
        .slice(0, 20)
        .map((b) => ({ ...b, title: b.title.slice(0, 120) }))
    : undefined;
  const history = Array.isArray(body.history)
    ? body.history.filter(
        (h): h is { role: Role; text: string } =>
          h != null && typeof h.text === "string" && (h.role === "user" || h.role === "assistant"),
      )
    : undefined;

  // scopeContext drops another domain's cart / catalog / goals for this tab.
  // Saved addresses carry no coordinates; the client sends the address's city
  // centre, or nothing when the city isn't recognised — then the agent must ask
  // which city/area before a Dineout or Scenes search instead of using Bengaluru.
  const located = typeof body.latitude === "number" && typeof body.longitude === "number";
  const city = typeof body.city === "string" ? body.city.slice(0, 60) : "";
  const baseLine = await resolveAddressLine(addressId, body.addressLine);
  const ctx: PromptContext = scopeContext(service, {
    addressLine: located
      ? city
        ? `${baseLine} — city: ${city} (Dineout/Scenes search coordinates are this city's centre)`
        : baseLine
      : `${baseLine} — city NOT recognised: for Dineout or Scenes, ask which city or area before searching (never assume Bengaluru)`,
    addressId,
    latitude: located ? (body.latitude as number) : DEFAULT_LAT,
    longitude: located ? (body.longitude as number) : DEFAULT_LNG,
    preferences: typeof body.preferences === "string" ? body.preferences.slice(0, 500) : undefined,
    allergies: typeof body.allergies === "string" ? body.allergies.slice(0, 300) : undefined,
    budget: typeof body.budget === "number" ? body.budget : undefined,
    kcalGoal: typeof body.kcalGoal === "number" ? body.kcalGoal : undefined,
    proteinGoal: typeof body.proteinGoal === "number" ? body.proteinGoal : undefined,
    // Recently-shown items so ADD/BEST/HEALTHY/WARN ids resolve across turns.
    catalog: body.catalog && typeof body.catalog === "object" ? body.catalog : undefined,
    cartLines,
    knownBookings,
    // the picker still open in the thread — rebuilt from known fields, size-capped
    activePicker: sanitizeActivePicker(body.activePicker),
  });

  // a follow-up question about cards already on screen → answer in text only
  const textOnly = !image && body.pickerRead !== true && isFollowUpQuestion(message, (history?.length ?? 0) > 0);

  // Stop button / closed tab: abort the LLM + MCP work instead of burning tokens.
  const abort = new AbortController();
  request.signal.addEventListener("abort", () => abort.abort(), { once: true });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: ChatStreamEvent) => {
        if (closed) return;
        try {
          controller.enqueue(line(event));
        } catch {
          closed = true; // client went away
        }
      };
      try {
        for await (const event of runChat({
          service,
          message,
          history,
          ctx,
          image,
          signal: abort.signal,
          // the AI read of a just-loaded picker never calls tools
          noTools: body.pickerRead === true && !!ctx.activePicker,
        })) {
          if (closed || abort.signal.aborted) break;
          if (textOnly && CARD_EVENTS.has(event.type)) continue;
          send(event);
        }
      } catch (err) {
        // runChat already converts errors into an `error` + `done` pair; this is
        // only reached if the stream itself breaks.
        const diag = isAuthError(err)
          ? classifyProviderError(401, "swiggy token expired")
          : classifyProviderError(500, err instanceof Error ? err.message : String(err));
        send({ type: "error", message: formatErrorMarkdown(diag) });
        send({ type: "done" });
      } finally {
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            // already closed by the runtime
          }
        }
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
});
