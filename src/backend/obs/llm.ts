// LLM call instrumentation, applied to every model of the provider chain
// (providers.ts), so all call sites — the chat runner, briefing / AI-read
// phrasing — get the same treatment without touching them:
//   - one `llm_call` log line per model call: provider, key slot, model, ms,
//     ok, input / output / cached tokens, finish reason (no prompt or reply text);
//   - circuit breaker feed: 429 (with Retry-After) / 401 / 403 open the whole
//     key; 5xx, timeouts and stream errors open that model on that key. The
//     chain skips open circuits (see providerChain) and falls through faster.
// A call aborted by the user (Stop button / closed tab) is not a provider failure.

import { wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from "ai";

import { breakers, parseRetryAfter } from "@/backend/resilience/breaker";
import { errorFields, log } from "./logger";

export interface LlmMeta {
  provider: string;
  keyIndex: number;
  modelId: string;
}

export const llmKeyId = (m: Pick<LlmMeta, "provider" | "keyIndex">) => `${m.provider}#${m.keyIndex}`;
export const llmModelId = (m: LlmMeta) => `${llmKeyId(m)}/${m.modelId}`;

type WrapStreamArgs = Parameters<NonNullable<LanguageModelMiddleware["wrapStream"]>>[0];
type StreamPart = WrapStreamArgs extends { doStream: () => PromiseLike<{ stream: ReadableStream<infer P> }> } ? P : never;

function statusOf(err: unknown, depth = 0): number | undefined {
  if (!err || typeof err !== "object" || depth > 4) return undefined;
  const e = err as { statusCode?: unknown; status?: unknown; lastError?: unknown; cause?: unknown };
  if (typeof e.statusCode === "number") return e.statusCode;
  if (typeof e.status === "number") return e.status;
  return statusOf(e.lastError, depth + 1) ?? (e.cause !== err ? statusOf(e.cause, depth + 1) : undefined);
}

function retryAfterOf(err: unknown): number | undefined {
  const headers = (err as { responseHeaders?: Record<string, string> } | null)?.responseHeaders;
  if (!headers) return undefined;
  return parseRetryAfter(headers["retry-after"] ?? headers["Retry-After"]);
}

function userAborted(signal: AbortSignal | undefined): boolean {
  if (!signal?.aborted) return false;
  const reason = signal.reason as { name?: string } | undefined;
  // Our own deadlines use AbortSignal.timeout → TimeoutError: that IS a slow provider.
  return reason?.name !== "TimeoutError";
}

function recordFailure(meta: LlmMeta, err: unknown): void {
  const status = statusOf(err);
  if (status === 429) {
    breakers.llm.failure(llmKeyId(meta), retryAfterOf(err) ?? 20_000);
  } else if (status === 401 || status === 403) {
    // A rejected key stays rejected — park it for the max cooldown.
    breakers.llm.failure(llmKeyId(meta), 300_000);
  } else if (status === undefined || status >= 500 || status === 408) {
    breakers.llm.failure(llmModelId(meta));
  }
}

function tokens(usage: unknown): Record<string, number> {
  const u = usage as
    | { inputTokens?: { total?: number; cacheRead?: number }; outputTokens?: { total?: number } }
    | undefined;
  const out: Record<string, number> = {};
  if (typeof u?.inputTokens?.total === "number") out.inputTokens = u.inputTokens.total;
  if (typeof u?.outputTokens?.total === "number") out.outputTokens = u.outputTokens.total;
  if (typeof u?.inputTokens?.cacheRead === "number" && u.inputTokens.cacheRead > 0) out.cachedTokens = u.inputTokens.cacheRead;
  return out;
}

function finishOf(reason: unknown): string | undefined {
  if (typeof reason === "string") return reason;
  const r = reason as { unified?: string } | undefined;
  return r?.unified;
}

function middleware(meta: LlmMeta): LanguageModelMiddleware {
  const base = { provider: meta.provider, key: meta.keyIndex, model: meta.modelId };
  return {
    wrapGenerate: async ({ doGenerate, params }) => {
      const started = Date.now();
      try {
        const result = await doGenerate();
        breakers.llm.success(llmModelId(meta));
        log.info("llm_call", { ...base, mode: "generate", ms: Date.now() - started, ok: true, finish: finishOf(result.finishReason), ...tokens(result.usage) });
        return result;
      } catch (err) {
        const aborted = userAborted(params.abortSignal);
        if (!aborted) recordFailure(meta, err);
        log.warn("llm_call", { ...base, mode: "generate", ms: Date.now() - started, ok: false, aborted, ...errorFields(err) });
        throw err;
      }
    },
    wrapStream: async ({ doStream, params }) => {
      const started = Date.now();
      let result;
      try {
        result = await doStream();
      } catch (err) {
        const aborted = userAborted(params.abortSignal);
        if (!aborted) recordFailure(meta, err);
        log.warn("llm_call", { ...base, mode: "stream", ms: Date.now() - started, ok: false, aborted, ...errorFields(err) });
        throw err;
      }
      let settled = false;
      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        const aborted = userAborted(params.abortSignal);
        if (!aborted) recordFailure(meta, err);
        log.warn("llm_call", { ...base, mode: "stream", ms: Date.now() - started, ok: false, aborted, ...errorFields(err) });
      };
      const observe = (part: StreamPart) => {
        const p = part as { type?: string; error?: unknown; usage?: unknown; finishReason?: unknown };
        if (settled) return;
        if (p.type === "error") fail(p.error);
        else if (p.type === "finish") {
          settled = true;
          breakers.llm.success(llmModelId(meta));
          log.info("llm_call", { ...base, mode: "stream", ms: Date.now() - started, ok: true, finish: finishOf(p.finishReason), ...tokens(p.usage) });
        }
      };
      const reader = result.stream.getReader();
      const stream = new ReadableStream<StreamPart>({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              if (!settled) fail(new Error("stream ended without finish"));
              controller.close();
              return;
            }
            observe(value);
            controller.enqueue(value);
          } catch (err) {
            fail(err);
            controller.error(err);
          }
        },
        // The consumer gave up (Stop, closed tab, step / chunk timeout).
        cancel(reason) {
          fail(reason ?? new Error("cancelled"));
          return reader.cancel(reason);
        },
      });
      return { ...result, stream };
    },
  };
}

/** Wrap a provider model with logging + breaker accounting. */
export function instrumentModel(model: LanguageModel, meta: LlmMeta): LanguageModel {
  if (typeof model === "string") return model;
  return wrapLanguageModel({ model, middleware: middleware(meta) });
}

/** Is this chain step's key or model currently in an open circuit? */
export function llmCircuitOpen(meta: LlmMeta): boolean {
  return breakers.llm.isOpen(llmKeyId(meta)) || breakers.llm.isOpen(llmModelId(meta));
}
