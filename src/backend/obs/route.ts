// Route-handler observability + the uniform API error shape.
//
//   export const GET = withObservability("GET /api/orders", handler)
//
// - assigns the request id (./context.ts), runs the handler inside it, and
//   returns it as the `x-request-id` response header;
// - logs one `route` line per request: method, route, status, ms (for a
//   streamed body, `ms` is time-to-headers and a `route_stream_end` line
//   carries the full duration);
// - normalises every error response (status ≥ 400) to
//     { ok: false, code, message, requestId, …existing fields }
//   keeping any extra fields the handler set (authRequired, busy, retryAfterSec…);
// - turns an uncaught throw into a 500 with a friendly message — never a stack.
// NDJSON / SSE streams are left as they are (the chat client reads its own
// `error` events); only the header and timing are added.

import { errorFields, log, scrub } from "./logger";
import { REQUEST_ID_HEADER, requestIdFrom, runWithContext } from "./context";

export type ApiErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "payload_too_large"
  | "invalid"
  | "rate_limited"
  | "internal"
  | "upstream_error"
  | "unavailable"
  | "timeout"
  | "error";

const CODE_BY_STATUS: Record<number, ApiErrorCode> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  413: "payload_too_large",
  422: "invalid",
  429: "rate_limited",
  500: "internal",
  502: "upstream_error",
  503: "unavailable",
  504: "timeout",
};

const FRIENDLY: Partial<Record<ApiErrorCode, string>> = {
  bad_request: "That request wasn't quite right — please try again.",
  unauthorized: "Your Swiggy session has expired — please log in again.",
  forbidden: "That action isn't allowed.",
  not_found: "We couldn't find that.",
  rate_limited: "You're going a little fast — please wait a moment and try again.",
  internal: "Something went wrong on our side. Please try again.",
  upstream_error: "Swiggy didn't respond as expected. Please try again.",
  unavailable: "This service is temporarily unavailable. Please try again shortly.",
  timeout: "That took too long. Please try again.",
};

export function codeForStatus(status: number): ApiErrorCode {
  return CODE_BY_STATUS[status] ?? (status >= 500 ? "internal" : "error");
}

/** Build a uniform error response. `extra` fields are kept (e.g. `{ authRequired: true }`). */
export function apiError(
  status: number,
  message?: string,
  opts: { code?: ApiErrorCode | string; requestId?: string; extra?: Record<string, unknown>; headers?: HeadersInit } = {},
): Response {
  const code = opts.code ?? codeForStatus(status);
  const body = {
    ...opts.extra,
    ok: false,
    code,
    message: message || FRIENDLY[code as ApiErrorCode] || "Something went wrong. Please try again.",
    ...(opts.requestId ? { requestId: opts.requestId } : {}),
  };
  return Response.json(body, { status, headers: opts.headers });
}

// A message that looks like a stack trace / internal error must not reach the user.
function safeMessage(raw: unknown, code: ApiErrorCode): string {
  if (typeof raw !== "string" || !raw.trim()) return FRIENDLY[code] ?? "Something went wrong. Please try again.";
  if (/\n\s+at\s|\bat\s+\S+\s+\(.*:\d+:\d+\)|node_modules|TypeError:|ReferenceError:|ECONN|ENOTFOUND/.test(raw)) {
    return FRIENDLY[code] ?? "Something went wrong. Please try again.";
  }
  return scrub(raw, 600);
}

async function normaliseError(res: Response, requestId: string): Promise<Response> {
  const type = res.headers.get("content-type") ?? "";
  if (/ndjson|event-stream/i.test(type)) return res;
  const code = codeForStatus(res.status);
  let parsed: Record<string, unknown> | null = null;
  let text = "";
  try {
    text = await res.text();
    if (/json/i.test(type) || /^\s*[{[]/.test(text)) {
      const j = JSON.parse(text) as unknown;
      if (j && typeof j === "object" && !Array.isArray(j)) parsed = j as Record<string, unknown>;
    }
  } catch {
    // unreadable / non-JSON body: fall through with the text
  }
  const base = parsed ?? {};
  const body = {
    ...base,
    ok: false,
    code: typeof base.code === "string" && base.code ? base.code : code,
    message: safeMessage(
      base.message ?? (typeof base.error === "string" ? base.error : undefined) ?? (parsed ? undefined : text.slice(0, 300)),
      code,
    ),
    requestId,
  };
  const headers = new Headers(res.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.delete("content-length");
  return new Response(JSON.stringify(body), { status: res.status, statusText: res.statusText, headers });
}

function withHeader(res: Response, requestId: string): Response {
  try {
    res.headers.set(REQUEST_ID_HEADER, requestId);
    return res;
  } catch {
    // Immutable headers (Response.redirect / fetch responses): copy.
    const headers = new Headers(res.headers);
    headers.set(REQUEST_ID_HEADER, requestId);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
}

function timeStream(res: Response, done: (ok: boolean) => void): Response {
  if (!res.body) return res;
  const reader = res.body.getReader();
  let finished = false;
  const finish = (ok: boolean) => {
    if (!finished) {
      finished = true;
      done(ok);
    }
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done: end, value } = await reader.read();
        if (end) {
          finish(true);
          controller.close();
        } else controller.enqueue(value);
      } catch (err) {
        finish(false);
        controller.error(err);
      }
    },
    cancel(reason) {
      finish(false);
      return reader.cancel(reason);
    },
  });
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Next passes `{ params }` of varying shapes
type Handler<A extends any[]> = (request: Request, ...rest: A) => Response | Promise<Response>;

/** Wrap a route handler with request id, latency logging and uniform errors. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withObservability<A extends any[]>(
  route: string,
  handler: Handler<A>,
): (request: Request, ...rest: A) => Promise<Response> {
  return (request: Request, ...rest: A) => {
    const requestId = requestIdFrom(request.headers);
    const startedAt = Date.now();
    return runWithContext({ requestId, route, startedAt }, async () => {
      let res: Response;
      try {
        res = await handler(request, ...rest);
      } catch (err) {
        // Next.js control flow (redirect() / notFound()) must propagate untouched.
        const digest = (err as { digest?: unknown })?.digest;
        if (typeof digest === "string" && /^NEXT_/.test(digest)) throw err;
        log.error("route_unhandled", { method: request.method, ...errorFields(err) });
        res = apiError(500, undefined, { requestId });
      }
      if (res.status >= 400) res = await normaliseError(res, requestId);
      res = withHeader(res, requestId);
      const ms = Date.now() - startedAt;
      const fields = { method: request.method, status: res.status, ms };
      if (res.status >= 500) log.error("route", fields);
      else if (res.status >= 400) log.warn("route", fields);
      else log.info("route", fields);

      const type = res.headers.get("content-type") ?? "";
      if (res.status < 400 && /ndjson|event-stream/i.test(type)) {
        return timeStream(res, (ok) =>
          runWithContext({ requestId, route, startedAt }, () =>
            log.info("route_stream_end", { method: request.method, ms: Date.now() - startedAt, ok }),
          ),
        );
      }
      return res;
    });
  };
}
