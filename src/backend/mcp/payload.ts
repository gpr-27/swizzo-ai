// Turn a Swiggy MCP tool result into the plain `data` object the tool documents.
// Every Swiggy tool replies with the envelope `{ success, data, message?, error? }`;
// `success:false` arrives with HTTP 200 and is an error, never data.

export class SwiggyEnvelopeError extends Error {
  constructor(
    message: string,
    readonly reportId?: string,
  ) {
    super(message);
    this.name = "SwiggyToolError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      return block.text;
    }
  }
  return undefined;
}

function allTexts(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((b): b is { type: string; text: string } => isRecord(b) && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .filter((t) => t.trim());
}

/** JSON.parse an object/array body; undefined for prose. */
function tryJson(text: string): unknown {
  const t = text.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return undefined;
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return undefined;
  }
}

/** Unwrap `{ success, data }`; throw on `success:false`. */
function unwrapEnvelope(value: unknown): unknown {
  if (isRecord(value) && value.success === false) {
    const err = isRecord(value.error) ? value.error : {};
    const message =
      (typeof err.message === "string" && err.message) ||
      (typeof value.message === "string" && value.message) ||
      "Swiggy returned an error";
    throw new SwiggyEnvelopeError(message, typeof err.reportId === "string" ? err.reportId : undefined);
  }
  if (isRecord(value) && "data" in value && ("success" in value || "status" in value)) {
    return value.data;
  }
  return value;
}

/** The envelope's human-readable `message` (checkout branding, payment status text), if any. */
export function envelopeMessage(raw: unknown): string | undefined {
  const body = isRecord(raw)
    ? isRecord(raw.structuredContent)
      ? raw.structuredContent
      : (() => {
          const t = firstText(raw.content);
          if (!t) return undefined;
          try {
            return JSON.parse(t) as unknown;
          } catch {
            return undefined;
          }
        })()
    : undefined;
  return isRecord(body) && typeof body.message === "string" ? body.message : undefined;
}

/**
 * Turn an arbitrary tool payload into a plain JS object.
 * - strings are JSON.parsed
 * - CallToolResult-like objects: throw on isError, prefer structuredContent,
 *   else JSON.parse the first text content block
 * - `{ success, data }` envelopes are unwrapped to `data`; `success:false` throws
 */
export function coerceToolPayload(raw: unknown): unknown {
  if (raw === null || raw === undefined) {
    throw new Error("Empty tool result");
  }

  if (typeof raw === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return raw;
    }
    return unwrapEnvelope(parsed);
  }

  // A bare array of content blocks (e.g. a tool_result block's `content`).
  if (Array.isArray(raw)) {
    const text = firstText(raw);
    if (!text) throw new Error("No text content in tool result");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { text };
    }
    return unwrapEnvelope(parsed);
  }

  if (isRecord(raw)) {
    // CallToolResult shape.
    if (Array.isArray(raw.content) || "isError" in raw || "structuredContent" in raw) {
      if (raw.isError === true) {
        const text = firstText(raw.content);
        let message = text || "Swiggy MCP returned an error";
        try {
          const parsed = text ? (JSON.parse(text) as unknown) : undefined;
          if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === "string") {
            message = parsed.error.message;
          }
        } catch {
          // plain-text error
        }
        throw new SwiggyEnvelopeError(message);
      }
      // An EMPTY structuredContent (`{}`) carries no data — live tools such as
      // get_food_order_details / search_restaurants_dineout put it in the text.
      if (isRecord(raw.structuredContent) && Object.keys(raw.structuredContent).length > 0) {
        return unwrapEnvelope(raw.structuredContent);
      }
      // Live responses often put a human-readable message in content[0] and
      // the JSON body in content[1]: use the first block that parses as JSON,
      // else hand back all the text.
      const texts = allTexts(raw.content);
      for (const t of texts) {
        const parsed = tryJson(t);
        if (parsed !== undefined) return unwrapEnvelope(parsed);
      }
      if (texts.length) return { text: texts.join("\n\n") };
      if (isRecord(raw.structuredContent)) return {};
      // Some tools (update_cart/clear_cart) return no content on success.
      return {};
    }
    return unwrapEnvelope(raw);
  }

  return raw;
}
