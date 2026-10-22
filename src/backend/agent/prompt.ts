// (intentionally empty)
//
// The Instamart-only `buildSystemPrompt(address)` that used to live here was
// dead code: the multi-service agent builds its system prompt from
// `buildServicePrompt(service, ctx)` in `services.ts`, and nothing imported
// this module. It was removed so there is a single source of truth for prompts.
//
// Add new prompt helpers to `services.ts` (per-service) rather than here.

export {};
