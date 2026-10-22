# Implementation rules for the fix-up pass (read before editing)

Seven agents are editing this codebase **at the same time**, each owning one area.
The goal: every tab (Instamart, Food, Dineout, Scenes) works end to end against
the real Swiggy MCP contracts, at production quality, with zero fake data.

## Authoritative contracts
`docs/swiggy-mcp/{instamart,food,dineout,scenes,platform}.md` (written from the
official Builders Club docs in `docs/swiggy-mcp/builders-llms-full.txt`).
Where code and docs disagree, the docs win.

## Shared infrastructure already landed (use it, don't fork it)
- `src/backend/mcp/client.ts`
  - `callTool(serverUrl, name, args, { signal?, maxRetries?, token? })` reuses one
    MCP session per (user token, server), retries only idempotent tools on
    network/5xx/429 (honours Retry-After, 30 s budget), and **throws**:
    `AuthError` (401/419/-32001 → user must log in), `SwiggyToolError`
    (`{success:false}` or isError; `.message` is Swiggy's user-facing text,
    `.reportId` for report_error), or the transport error.
  - `callToolData(...)` = callTool + coerceToolPayload → the unwrapped `data`.
  - Non-idempotent tools (checkout, place_food_order, book_table, cancel_booking,
    create_cart, create_event_cart, place_event_order, create/delete_address,
    apply_coupon, apply_food_coupon, report_error) are never auto-retried. On an
    ambiguous failure of an order-placing tool: wait 2–5 s, read state
    (get_orders / get_food_orders / get_booking_status / get_event_booking_status),
    and only report success if the order exists.
- `src/backend/mcp/payload.ts` — `coerceToolPayload` (throws on `success:false`),
  `envelopeMessage(raw)` for the envelope `message`.
- `src/shared/types.ts` — `PaymentSession` now has `transactionId`,
  `upiIntentUrl`, `echo { addressId, cartId, lat, lng, cartKey }`. Build a
  PaymentSession ONLY from a real PENDING_PAYMENT place-order response.
- LLM layer (owned by the lead, don't restructure): `src/backend/agent/providers.ts`
  (Claude Haiku → Groq ×2 → Gemini ×2), `runner.ts` (tool loop, `summarize()` of
  tool results back to the model), `tools.ts` (`buildServiceTools` — the
  read-only tools the model may call per service; `injectedArgs` adds
  addressId or lat/lng). Per-service owners MAY edit their own `case` in
  `tools.ts`, their own `case`s in `agent.ts mapToolResult/statusLabel`, their
  own branch of `summarize()` in runner.ts, and their own service prompt in
  `services.ts buildServicePrompt` — nothing else in those files.
- A `{ type: "model", info: GeneratedBy }` stream event names the LLM that
  answered; `ChatMessage.generatedBy` stores it (UI shows it under the reply).

## Hard rules
1. **No mock / fake / invented data anywhere.** Delete getMock*, fabricated ids
   (`fd_${Date.now()}`, `TKT-…`, `sw_…`), invented prices/ratings/offers/images,
   invented UPI VPAs, fake bridge URLs, "optimistic" confirmations, simulate
   buttons. On failure, show the real Swiggy error message to the user.
2. **Never call mutating tools live while testing** (no checkout / place_* /
   book_table / create_*cart / confirm_order). The on-disk token is expired anyway.
3. Order placement stays behind explicit user confirmation in the UI. Server gate:
   env `SWIGGY_ENABLE_ORDERS` (`"true"` enables; otherwise return
   `{ placed:false, gated:true, message:"Ordering is disabled on this server" }` —
   never a fake success). Replace older ENABLE_CHECKOUT / ENABLE_FOOD_ORDER flags with it.
4. **Concurrent editing:** other agents edit other regions of the shared files
   (`src/frontend/hooks/useSwiggyChat.ts`, `src/shared/types.ts`,
   `src/backend/agent/agent.ts`, `services.ts`, `tools.ts`, `runner.ts`,
   `src/frontend/components/chat/MessageBubble.tsx`, `src/app/page.tsx`).
   In those files: only small targeted `Edit` calls inside regions you own;
   never `Write` the whole file, never reformat or reorder unrelated code. If an
   Edit fails because the file changed, re-Read the region and retry.
5. Keep code style consistent with the surrounding file (comment density, naming).
6. Validate: `npx tsc --noEmit` and `npx eslint <your files>`. Fix everything in
   your files; ignore transient errors in other agents' files.
7. Don't start/stop servers on port 3000 (the lead runs `npm run dev`). Don't
   `npm install` new packages unless essential — if you must, say so in your report.
8. Final message: files changed, what you fixed (map to your finding numbers),
   anything left undone or uncertain, and anything another owner must do.

---
## Round 2 addendum (2026-10-22)
- **Real data beats docs.** `docs/swiggy-mcp/LIVE-SAMPLES.md` holds raw responses captured from the live servers.
  Several docs-based parsers were wrong (Dineout search is text-only; slots live in `result._meta.slots`;
  Scenes discover is empty server-side; Scenes tickets are `{id,name,price.price.units}`).
- You have the live Swiggy MCP tools in your toolset (`mcp__swiggy-food__*`, `mcp__swiggy-instamart__*`,
  `mcp__swiggy-dineout__*`, `mcp__swiggy-scenes__*`). CALL THE READ-ONLY ONES to verify shapes
  (search/get/list/discover/render/details/slots/shows/menu/cart/orders/payment_options). Note: that tool
  display shows `structuredContent` when present, so a `{}` there means the data is in the text content.
  NEVER call mutating tools (update_cart, clear_cart, checkout, place_*, book_table, create_*cart,
  apply_*coupon, confirm_order, create/delete_address, cancel_booking, flush_food_cart, report_error).
- `coerceToolPayload` (src/backend/mcp/payload.ts) returns `structuredContent` when it is a record — if a tool's
  structuredContent is `{}`/lacks the data, read `content[].text` (or `_meta`) from the raw ToolResult yourself
  (use `callTool` and inspect, don't change payload.ts semantics for other tools without care).
- Verify your parsers by running them with `npx tsx --tsconfig tsconfig.json <script>` against the captured
  payloads. Do NOT run `next build`/`next dev`/`next start` (several agents share `.next`; the lead builds and
  browser-tests at the end).
- Photo cards: every card that has a real image URL from Swiggy must show it (Instamart products, Food dishes /
  restaurants, Dineout restaurants via render_restaurants_dineout / details). Where Swiggy provides NO image
  (Scenes), use a tasteful generated genre artwork (CSS gradient + icon + title), clearly not a fake photo.
