// `npm test` must never touch the network (no Swiggy, no LLMs). Any fetch a
// test did not stub explicitly fails loudly instead of silently going out.
import { afterEach, beforeEach } from "vitest";

const realFetch = globalThis.fetch;

function blockedFetch(input: RequestInfo | URL): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return Promise.reject(
    new Error(`[tests] network disabled: fetch(${url}) — stub it (vi.stubGlobal("fetch", …)) or use the live suite`),
  );
}

function offline() {
  globalThis.fetch = blockedFetch as typeof fetch;
  // Live-only credentials never leak into the offline suites.
  for (const k of ["SWIGGY_TOKEN", "ANTHROPIC_API_KEY", "GROQ_API_KEY", "GROQ_API_KEY_2", "GEMINI_API_KEY", "GEMINI_API_KEY_2", "AXON_API_KEY"]) {
    delete process.env[k];
  }
}
// at load too: script suites run their checks while the file is collected
offline();
beforeEach(offline);

afterEach(() => {
  globalThis.fetch = blockedFetch as typeof fetch;
});

export { realFetch };
