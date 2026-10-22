// Reliability / observability checks (no network):
//   npx tsx --tsconfig tsconfig.json scripts/verify-reliability.ts
import { BoundedMap } from "../src/backend/resilience/lru";
import { CircuitBreaker, parseRetryAfter, backoffMs } from "../src/backend/resilience/breaker";
import { checkEnv } from "../src/backend/config/env-schema";
import { scrub } from "../src/backend/obs/logger";
import { withObservability, apiError } from "../src/backend/obs/route";

let passed = 0;
function ok(cond: unknown, name: string): void {
  if (!cond) {
    console.error(`FAIL ${name}`);
    process.exit(1);
  }
  passed++;
}

async function main() {
  // BoundedMap: size cap + LRU + TTL + onEvict
  const evicted: string[] = [];
  const m = new BoundedMap<string, number>({ max: 2, ttlMs: 50, onEvict: (k) => evicted.push(k) });
  m.set("a", 1).set("b", 2);
  m.get("a"); // a is now most recent
  m.set("c", 3);
  ok(!m.has("b") && m.has("a") && m.has("c") && m.size === 2, "lru evicts least recently used");
  ok(evicted.includes("b"), "onEvict called");
  await new Promise((r) => setTimeout(r, 70));
  ok(m.get("a") === undefined && m.size === 1, "ttl expiry on read");

  // Breaker
  const br = new CircuitBreaker("t", { threshold: 2, cooldownMs: 1000 });
  ok(br.check("x").ok, "closed by default");
  br.failure("x");
  ok(br.check("x").ok, "one failure stays closed");
  br.failure("x");
  ok(!br.check("x").ok, "threshold opens");
  br.success("x");
  ok(br.check("x").ok, "success closes");
  br.failure("y", 5000);
  const v = br.check("y");
  ok(!v.ok && v.retryInMs > 4000, "retry-after opens immediately");
  ok(parseRetryAfter("3") === 3000 && parseRetryAfter(null) === undefined, "parseRetryAfter");
  for (let i = 0; i < 20; i++) {
    const d = backoffMs(i);
    ok(d >= 0 && d <= 8000, "backoff capped");
  }

  // Env contract
  const prod = process.env.NODE_ENV;
  const bad = checkEnv({});
  ok(!bad.ok && bad.errors.some((e) => e.includes("LLM")), "missing LLM key reported");
  const good = checkEnv({ GROQ_API_KEY: "gsk_x", APP_BASE_URL: "http://localhost:3000" });
  ok(good.ok, "dev env with one key is ok");
  ok(!JSON.stringify(checkEnv({ GROQ_API_KEY: "gsk_SECRETVALUE" })).includes("SECRETVALUE"), "report never contains values");
  (process.env as Record<string, string | undefined>).NODE_ENV = "production";
  const p1 = checkEnv({ GROQ_API_KEY: "k" });
  ok(p1.errors.some((e) => e.startsWith("SESSION_SECRET")) && p1.errors.some((e) => e.startsWith("APP_BASE_URL")), "prod requires secret + base url");
  (process.env as Record<string, string | undefined>).NODE_ENV = prod;

  // Scrubbing
  ok(!scrub("Bearer abc.def.ghi call 9876543210").includes("9876543210"), "phone scrubbed");
  ok(!scrub("Authorization: Bearer abcdef123").includes("abcdef123"), "bearer scrubbed");

  // Route wrapper: uniform error, request id, no stack leak
  const throwing = withObservability("t", async () => {
    throw new Error("TypeError: boom\n    at x (/app/node_modules/y.js:1:2)");
  });
  const r1 = await throwing(new Request("http://x/api/t"));
  const b1 = (await r1.json()) as Record<string, unknown>;
  ok(r1.status === 500 && b1.ok === false && b1.code === "internal" && typeof b1.requestId === "string", "500 uniform shape");
  ok(!JSON.stringify(b1).includes("node_modules"), "no stack in body");
  ok(r1.headers.get("x-request-id") === b1.requestId, "request id header matches body");

  const legacy = withObservability("t", async () => Response.json({ ok: false, message: "Nope", busy: true }, { status: 429 }));
  const b2 = (await (await legacy(new Request("http://x"))).json()) as Record<string, unknown>;
  ok(b2.code === "rate_limited" && b2.message === "Nope" && b2.busy === true && b2.requestId, "legacy error normalised, extras kept");

  const text = withObservability("t", async () => new Response("Unauthorized", { status: 401 }));
  const b3 = (await (await text(new Request("http://x"))).json()) as Record<string, unknown>;
  ok(b3.code === "unauthorized" && b3.ok === false, "text error → json");

  const okr = withObservability("t", async () => Response.json({ ok: true }));
  const r4 = await okr(new Request("http://x", { headers: { "x-request-id": "abcdef12-3456" } }));
  ok(r4.headers.get("x-request-id") === "abcdef12-3456" && ((await r4.json()) as { ok: boolean }).ok, "success passthrough + incoming id");

  const ndjson = withObservability("t", async () => {
    const enc = new TextEncoder();
    return new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(enc.encode('{"type":"text"}\n'));
          c.enqueue(enc.encode('{"type":"done"}\n'));
          c.close();
        },
      }),
      { headers: { "Content-Type": "application/x-ndjson" } },
    );
  });
  const body = await (await ndjson(new Request("http://x"))).text();
  ok(body.split("\n").filter(Boolean).length === 2, "ndjson stream passes through intact");

  ok(apiError(404).status === 404, "apiError");
  console.log(`reliability: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
