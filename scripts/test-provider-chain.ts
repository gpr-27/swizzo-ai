// Verifies the LLM fallback order by blanking the keys ahead of each step and
// asking one chit-chat question (no Swiggy tools needed).
// Run: npx tsx --env-file=.env.local scripts/test-provider-chain.ts

import { runChatChain } from "@/backend/agent/runner";
import type { ChatStreamEvent } from "@/shared/types";

const STEPS: { label: string; blank: string[] }[] = [
  { label: "all keys", blank: [] },
  { label: "no Anthropic", blank: ["ANTHROPIC_API_KEY"] },
  { label: "no Anthropic, no Groq #1", blank: ["ANTHROPIC_API_KEY", "GROQ_API_KEY"] },
  { label: "only Gemini", blank: ["ANTHROPIC_API_KEY", "GROQ_API_KEY", "GROQ_API_KEY_2"] },
  {
    label: "only Gemini #2",
    blank: ["ANTHROPIC_API_KEY", "GROQ_API_KEY", "GROQ_API_KEY_2", "GEMINI_API_KEY"],
  },
  { label: "bad Anthropic key falls through", blank: [] },
];

async function main() {
  const saved = { ...process.env };
  for (const [i, step] of STEPS.entries()) {
    process.env = { ...saved };
    for (const k of step.blank) process.env[k] = "";
    if (i === STEPS.length - 1) process.env.ANTHROPIC_API_KEY = "sk-ant-invalid";
    const started = Date.now();
    let model = "";
    let text = "";
    try {
      for await (const ev of runChatChain({
        service: "instamart",
        message: "Reply with just the word OK.",
        ctx: { addressLine: "Bengaluru", addressId: "x", latitude: 12.97, longitude: 77.59 },
      }) as AsyncGenerator<ChatStreamEvent>) {
        if (ev.type === "model") model = `${ev.info.label} (${ev.info.step}, fallbacks=${ev.info.fallbacks})`;
        if (ev.type === "text") text += ev.delta;
      }
      console.log(`✓ ${step.label}: ${model} → "${text.slice(0, 40)}" in ${Date.now() - started}ms`);
    } catch (err) {
      console.log(`✗ ${step.label}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

void main();
