// Redaction for logs and outbound error reports. Swiggy tokens, our sealed
// session cookie, LLM API keys and the user's PII (phone, email, name,
// address, coordinates) must never reach server logs or report_error.
//
//   redactText(s)        → string with secrets / phones / emails masked
//   redact(value)        → deep copy with sensitive KEYS masked and every string redacted
//   installConsoleRedaction() → wraps console.* once per process (idempotent)
//
// Pure functions, no Next/Node request APIs — safe to import anywhere server-side.

const MASK = "[redacted]";

// Order matters: tokens before the generic long-number / phone rules.
const TEXT_RULES: [RegExp, string][] = [
  // JWTs (Swiggy access/refresh tokens are JWTs)
  [/\beyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]{6,}\b/g, "[jwt]"],
  // Authorization headers / bearer tokens
  [/\b(Bearer|Basic)\s+[\w.~+/=-]{8,}/gi, "$1 [token]"],
  // Our sealed session / OAuth-state cookie values ("v1.<base64url>")
  [/\bv1\.[\w-]{40,}/g, "[sealed]"],
  // LLM / cloud API keys (Anthropic, Groq, Google, OpenAI-style)
  [/\bsk-ant-[\w-]{10,}/g, "[api-key]"],
  [/\bgsk_[\w]{10,}/g, "[api-key]"],
  [/\bAIza[\w-]{20,}/g, "[api-key]"],
  [/\bsk-[\w-]{20,}/g, "[api-key]"],
  // key=value / "key":"value" pairs for obviously secret keys
  [
    /(["']?(?:access_token|refresh_token|id_token|client_secret|code_verifier|session_secret|api[_-]?key|password|authorization|cookie)["']?\s*[:=]\s*)(["']?)[^"'\s&,;}]+\2/gi,
    `$1$2${MASK}$2`,
  ],
  // e-mail addresses
  [/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, "[email]"],
  // Indian mobile numbers: optional +91 / 0, then 10 digits starting 6-9
  [/(?<![\w.])(?:\+?91[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}(?![\w.])/g, "[phone]"],
];

/** Mask secrets, phone numbers and e-mails inside free text. */
export function redactText(input: string): string {
  let out = input;
  for (const [re, rep] of TEXT_RULES) out = out.replace(re, rep);
  return out;
}

// Object keys whose VALUES are always masked (case-insensitive). Ids such as
// addressId / orderId are kept: they are needed to debug and are not PII alone.
const SENSITIVE_KEY =
  /^(?:.*(?:token|secret|password|authorization|cookie|verifier|apikey|api_key)|(?:user|receiver|account|customer|full|first|last)_?name|(?:user|receiver)?_?phone|mobile|phone_?number|email|(?:full)?_?address|address_?line\d?|addressline\d?|street|flat(?:no)?|landmark|postal_?code|pincode|lat|lng|latitude|longitude|annotation)$/i;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key) && !/id$/i.test(key);
}

/** Deep-redacted copy for logging (depth/size bounded; cycles safe). */
export function redact(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Error) return redactError(value);
  if (seen.has(value)) return "[circular]";
  if (depth > 6) return "[…]";
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
    out[k] = isSensitiveKey(k) && v !== undefined && v !== null && v !== "" ? MASK : redact(v, depth + 1, seen);
  }
  return out;
}

/** An Error with message / stack (and a cause chain) redacted; keeps name + extra fields. */
export function redactError(err: Error): Error {
  const copy = new Error(redactText(err.message));
  copy.name = err.name;
  copy.stack = err.stack ? redactText(err.stack) : undefined;
  for (const [k, v] of Object.entries(err)) {
    if (k === "name" || k === "message" || k === "stack") continue;
    (copy as unknown as Record<string, unknown>)[k] = isSensitiveKey(k) ? MASK : redact(v, 1);
  }
  if ("cause" in err && err.cause !== undefined) {
    (copy as Error & { cause?: unknown }).cause = redact(err.cause, 1);
  }
  return copy;
}

/* ------------------------------ console wrapper ----------------------------- */

const METHODS = ["log", "info", "warn", "error", "debug", "trace"] as const;
const g = globalThis as unknown as { __swizzoConsoleRedacted?: boolean };

/**
 * Route every console.* argument through `redact` (server-side, once per
 * process). Imported by the shared route wrapper so every API route — and
 * everything it calls (MCP client, agent, session) — logs redacted text.
 */
export function installConsoleRedaction(): void {
  if (g.__swizzoConsoleRedacted || typeof console === "undefined") return;
  g.__swizzoConsoleRedacted = true;
  for (const m of METHODS) {
    const original = console[m].bind(console) as (...args: unknown[]) => void;
    (console as unknown as Record<string, (...args: unknown[]) => void>)[m] = (...args: unknown[]) => {
      let safe: unknown[];
      try {
        safe = args.map((a) => redact(a));
      } catch {
        safe = ["[log redaction failed]"];
      }
      original(...safe);
    };
  }
}
