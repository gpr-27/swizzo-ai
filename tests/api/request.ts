// Request builder for calling route handlers directly, shaped like the app's
// own browser fetches (same-origin, JSON). Each call gets its own client IP so
// per-IP rate limits never couple tests together.
let ip = 0;

export const BASE = "http://localhost:3000";

export function req(
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string>; ip?: string } = {},
): Request {
  const method = init.method ?? (init.body === undefined ? "GET" : "POST");
  const headers: Record<string, string> = {
    host: "localhost:3000",
    "x-forwarded-for": init.ip ?? `10.9.${(++ip >> 8) & 255}.${ip & 255}`,
    "sec-fetch-site": "same-origin",
    ...(method !== "GET" ? { origin: BASE } : {}),
    ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    ...init.headers,
  };
  return new Request(`${BASE}${path}`, {
    method,
    headers,
    body: init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body),
  });
}

/** Parse an NDJSON stream body into events. */
export async function ndjson(res: Response): Promise<Record<string, unknown>[]> {
  const text = await res.text();
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}
