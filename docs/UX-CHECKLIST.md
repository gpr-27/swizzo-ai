# UX / Performance / Accessibility checklist

Verified 2026-10-23 against an isolated production build (`next start -p 3300`) behind a
local mock proxy (all `/api/*` answered with fixtures; mutating routes hard-blocked).
No real Swiggy tools were called and no Confirm / Pay / Checkout / Approve was tapped.

## Performance (Lighthouse 12, mobile, simulated throttling)

| Page | Before | After |
|---|---|---|
| Logged-out landing | Perf 82–83, LCP 4.6–4.7 s, TBT 70–110 ms, CLS 0 | Perf 92, LCP 3.4 s, TBT 10 ms, CLS 0 |
| Initial JS (gz, from HTML) | ~412 KiB (one 228 KiB page chunk) | ~307 KiB (app code ~125 KiB) |
| Signed-in landing (mock) | Perf 77–79, LCP 5.5–5.6 s, CLS 0.04–0.066 | not re-measured after the CLS/LCP fixes below |
| Chat with product cards (Playwright CLS) | 0.035 (phones) | 0.028–0.029 (phones), ≤0.006 (tablet/desktop) |

- [x] Login gate is server-rendered when the request has no session cookie (`AuthHintProvider` in layout).
- [x] Components barrel no longer imported by app code (it pulled every component into the first bundle).
- [x] Code-split: payment modal, address modal, history view, reorder dialog, live plan panel, Dineout compare tray, shared-basket banner, every service-specific chat card, and the Markdown renderer (`chat/lazy.tsx`); warmed on idle.
- [x] Chat thread: memoised bubbles + identity-stable callbacks, so a streaming reply re-renders only its own turn; turns older than the last 10 use `content-visibility: auto`.
- [x] Images: `decoding="async"` everywhere; first two Usuals tiles (the LCP) eager + `fetchPriority="high"`.
- [x] Fonts via `next/font` (already).
- [x] Header no longer reflows when auth resolves (placeholder pill); Usuals board shows a skeleton, not "empty", until addresses load.

## Accessibility (axe-core WCAG 2.2 AA; 12 states × light/dark × 390/1280)

- Before: 29 distinct violations. After: 3 (listed under Remaining).
- [x] Palette: coral `#a65034` (light), muted/muted-soft/success/teal/amber/error inks deepened to ≥4.5:1; dark theme keeps `#cc785c` with dark ink on coral fills.
- [x] Label-in-name fixes (address picker, account, chats).
- [x] Focus trap, Esc and focus return: payment modal, add-address modal, Dineout details sheet, Scenes ticket modal, account menu Esc.
- [x] Live region: the settled reply text is announced; the implicit live log is switched off, so card grids are no longer read aloud.
- [x] Reduced motion: thread autoscroll respects it (CSS guard already existed).
- [x] Touch: `.tap` gives a 44×44 hit area on coarse pointers for small chips and icon buttons and all top-bar controls.

## Mobile (360 / 390 / 414 / 768 / 1024–1440)

- [x] No horizontal overflow at any width tested.
- [x] Phones: three-row header. All 5 service tabs are visible with labels and are 44 px tall. Before, only about 1 tab was visible.
- [x] Desktop address pill stays readable (≥ 8.5rem).
- [x] Composer placeholder stays on one line.
- [x] Text typed before hydration is kept (verified: JS held 2.5 s, typed, value survived and Send was enabled).

## Remaining

- Cart tray text: 10px `#5a5a5b` on `#131315` (2.7:1).
- `.topnav-cart` label-in-name when the cart has items.
- PWA manifest, icons and OG metadata: not done.
- Signed-in Lighthouse not re-run after the final fixes.
- `global-error.tsx` still uses the old coral.
