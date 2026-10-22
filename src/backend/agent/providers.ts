// LLM provider chain, tried strictly in this order (one key per step, every
// model of a step before moving to the next key):
//   1. Anthropic  ANTHROPIC_API_KEY  claude-haiku-5-5
//   2. Groq       GROQ_API_KEY       gpt-oss-120b → gpt-oss-20b → qwen3.8-27b
//   3. Groq       GROQ_API_KEY_2     same three
//   4. Gemini     GEMINI_API_KEY     gemini-3.5-flash → gemini-3.8-flash → gemini-flash-latest
//   5. Gemini     GEMINI_API_KEY_2   same three
// A step with a blank key is skipped. Keys are server-only (.env.local locally,
// Project Settings on Vercel) — never prefix them with NEXT_PUBLIC_.

import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import type { LanguageModel } from "ai";

import { instrumentModel, llmCircuitOpen } from "@/backend/obs/llm";

export type ProviderId = "anthropic" | "groq" | "gemini";

export interface ModelSpec {
  id: string;
  /** Human label shown in the UI under each reply. */
  label: string;
  /** Accepts image input (photo turns skip models that don't). */
  vision: boolean;
}

export interface ChainAttempt {
  provider: ProviderId;
  /** Which key of that provider (1-based), for logs and the UI badge. */
  keyIndex: number;
  /** e.g. "Groq · key 2" */
  stepLabel: string;
  model: ModelSpec;
  languageModel: LanguageModel;
  providerOptions: Record<string, Record<string, unknown>>;
}

const CLAUDE_MODELS: ModelSpec[] = [
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", vision: true },
];

const GROQ_MODELS: ModelSpec[] = [
  { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B", vision: false },
  { id: "openai/gpt-oss-20b", label: "GPT-OSS 20B", vision: false },
  { id: "qwen/qwen3.8-27b", label: "Qwen 3.8 27B", vision: true },
];

// gemini-3.5-flash is first: it answered on both keys when the newer aliases
// were returning 503 "high demand" (verified 2026-10-22).
const GEMINI_MODELS: ModelSpec[] = [
  { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", vision: true },
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", vision: true },
  { id: "gemini-flash-latest", label: "Gemini Flash (latest)", vision: true },
];

function groqOptions(modelId: string): Record<string, unknown> {
  // gpt-oss spends output tokens on hidden reasoning; keep it low so the
  // 8K-TPM free tier and our latency budget hold. Qwen runs in instruct mode.
  return modelId.startsWith("qwen/")
    ? { reasoningEffort: "none", parallelToolCalls: true }
    : { reasoningEffort: "low", parallelToolCalls: false };
}

/** The ordered list of (key, model) attempts for this request. */
export function providerChain(
  env: Record<string, string | undefined> = process.env,
  opts: { needsVision?: boolean } = {},
): ChainAttempt[] {
  const out: ChainAttempt[] = [];
  const keep = (m: ModelSpec) => !opts.needsVision || m.vision;

  const anthropicKey = env.ANTHROPIC_API_KEY?.trim();
  if (anthropicKey) {
    const anthropic = createAnthropic({ apiKey: anthropicKey });
    for (const model of CLAUDE_MODELS.filter(keep)) {
      out.push({
        provider: "anthropic",
        keyIndex: 1,
        stepLabel: "Anthropic",
        model,
        languageModel: instrumentModel(anthropic(model.id), { provider: "anthropic", keyIndex: 1, modelId: model.id }),
        // Chat-concierge latency matters more than deep reasoning.
        providerOptions: { anthropic: { effort: "low" } },
      });
    }
  }

  const groqKeys = [env.GROQ_API_KEY, env.GROQ_API_KEY_2];
  groqKeys.forEach((raw, i) => {
    const apiKey = raw?.trim();
    if (!apiKey) return;
    const groq = createGroq({ apiKey });
    for (const model of GROQ_MODELS.filter(keep)) {
      out.push({
        provider: "groq",
        keyIndex: i + 1,
        stepLabel: `Groq · key ${i + 1}`,
        model,
        languageModel: instrumentModel(groq(model.id), { provider: "groq", keyIndex: i + 1, modelId: model.id }),
        providerOptions: { groq: groqOptions(model.id) },
      });
    }
  });

  const geminiKeys = [env.GEMINI_API_KEY, env.GEMINI_API_KEY_2];
  geminiKeys.forEach((raw, i) => {
    const apiKey = raw?.trim();
    if (!apiKey) return;
    const google = createGoogleGenerativeAI({ apiKey });
    for (const model of GEMINI_MODELS.filter(keep)) {
      out.push({
        provider: "gemini",
        keyIndex: i + 1,
        stepLabel: `Gemini · key ${i + 1}`,
        model,
        languageModel: instrumentModel(google(model.id), { provider: "gemini", keyIndex: i + 1, modelId: model.id }),
        // Default thinking made replies take ~1 min; low keeps it in budget.
        providerOptions: { google: { thinkingConfig: { thinkingLevel: "low" } } },
      });
    }
  });

  // Fast-fail: skip keys / models whose circuit is open (429 Retry-After, rejected
  // key, repeated 5xx / timeouts — see obs/llm.ts). If every step is open, try
  // them all anyway rather than fail without asking anyone.
  const live = out.filter((a) => !llmCircuitOpen({ provider: a.provider, keyIndex: a.keyIndex, modelId: a.model.id }));
  return live.length ? live : out;
}

/** HTTP status carried by an AI SDK / provider error, if any. */
export function errorStatus(err: unknown): number | undefined {
  if (err && typeof err === "object") {
    const e = err as { statusCode?: unknown; status?: unknown; lastError?: unknown; cause?: unknown };
    if (typeof e.statusCode === "number") return e.statusCode;
    if (typeof e.status === "number") return e.status;
    if (e.lastError) return errorStatus(e.lastError);
    if (e.cause && e.cause !== err) return errorStatus(e.cause);
  }
  return undefined;
}

/** A rejected key won't work for its other models — skip to the next key. */
export function isKeyRejected(err: unknown): boolean {
  const s = errorStatus(err);
  return s === 401 || s === 403;
}
