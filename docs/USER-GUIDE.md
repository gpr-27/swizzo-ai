# Swizzo — User Guide

Swizzo is an AI concierge for your Swiggy account. It talks to Swiggy's four official
Builders Club servers — **Instamart, Food, Dineout, Scenes** — plus a **Plan** tab that combines
them and a **History** page for everything you've ordered or booked.

Every price, photo, slot, seat count and status you see comes from Swiggy. Swizzo never books,
orders or pays on its own: every order, booking and payment waits for you to confirm.

---

## 1. Getting started

1. Open **http://localhost:3000**.
2. Click **Login with Swiggy** → enter your phone number and OTP on Swiggy's page.
3. You're back in Swizzo. Your session lasts ~5 days and refreshes itself; if it ever expires,
   the app shows a **Log in** prompt.
4. Pick your **delivery address** with the 📍 pill at the top. Instamart and Food use it for
   delivery; Dineout and Scenes use its city to find places and events near you.

Under every reply you'll see a small badge naming the AI model that wrote it
(e.g. *Claude Haiku 5.5*). If one model is busy, Swizzo automatically falls back to the next
(Claude → Groq → Gemini), and the badge says so.

---

## 2. The tabs

Each tab only does its own job. Ask Scenes for biryani and it replies with an
**Open in Food →** button instead of mixing things up. Use **Plan** when you want several at once.

### 🛒 Instamart — groceries in minutes
- **Search:** type what you need ("Amul Gold 1L", "eggs", "snacks for movie night"). Every
  product shows its official photo, pack size, price, MRP and discount. The AI marks the
  **best value** and the **healthiest** pick.
- **Your usuals:** the home screen shows what you buy again. Untick anything, then **Review**.
- **Recipes:** "ingredients for chicken biryani" → the app searches every ingredient and
  proposes the best pick of each (Approve / Dismiss).
- **Cart (right panel / Cart button on phone):** change quantities (capped at what Swiggy has in
  stock), remove items, see Swiggy's real bill (item total, fees, To Pay). Minimum order ₹99.
- **Checkout:** tap **Checkout** → pick a payment method from the ones Swiggy offers for this
  cart (UPI apps, Scan QR, Cash on delivery, Swiggy Money) → confirm. UPI opens a payment sheet
  that waits for Swiggy to confirm the payment.
- **Track:** "where's my order" shows live status and ETA while an order is on the way.

### 🍽️ Food — restaurant delivery
- **Dishes across restaurants:** "paneer tikka", "chicken biryani" → dish cards from nearby open
  restaurants, with photos, price, veg/non-veg and rating. Use **More dishes** for the next page.
- **Restaurants & menus:** "pizza places near me" → restaurant cards; **View menu** loads the
  menu directly; **More categories** / **N more in <category>** page through big menus.
- **Customise:** dishes with sizes or add-ons open a picker before they go into the cart.
- **Cart:** one restaurant at a time (adding from another restaurant asks before switching).
  **All coupons** lists Swiggy's coupons for this cart with **Apply**, or type a code.
  Toggle **Send cutlery**, add a **note to the restaurant**.
- **Place order:** pick a returned payment method → confirm. Swiggy re-checks the cart and price
  right before placing.
- **Track:** live status / ETA for an active order, with a link to Swiggy's tracking page.
- **Cancel:** Swiggy doesn't allow apps to cancel food orders — call **080-67466729**.

### 🥂 Dineout — table reservations
- **Find:** "rooftop places in Indiranagar", "Italian in Koramangala", "buffet" → photo cards
  with rating (and review count), cost for two, distance, the headline offer and highlights.
- **View details:** photo gallery (tap to zoom), timings, address, **Directions**, amenities,
  deals, menu pages (lightbox), **Share**, and a **bill-split estimate**.
- **Compare:** tick **Compare** on up to 3 restaurants → side-by-side sheet (rating, cost,
  distance, offers, timings, amenities; best value highlighted).
- **Reserve:** opens the live slot picker — 7 days, grouped by Breakfast / Lunch / Dinner, with
  how many slots are open, free vs paid deals and the **Best deal this week** (one tap to pick).
  The picker refreshes about once a minute while it's open ("Updated Ns ago").
  - **Free deal:** choose guests (1–20) → confirm → booked; the booking card shows Swiggy's
    status.
  - **Paid deal:** confirm → booking summary with Swiggy's amount → pick a UPI app or QR → pay.
- **Booking card:** live status (auto-refresh), **Refresh**, **Add to calendar**,
  **Directions**, **Share**, countdown ("Starts in 2h 15m"), bill split.
- **Cancel:** shown when Swiggy enables it for your account; until then the card points you to
  the Dineout app or **080-67466729**.

### 🎟️ Scenes — events & shows
- **Find:** "comedy shows this weekend", "live music", or an artist name → poster cards for
  events in your city (Swiggy provides no event photos, so Swizzo draws a poster from the
  event's own details).
- **See shows & tickets:** dates with seats available per date, every show time, each ticket
  tier with price and **seats left**, "Selling fast" when ≤5 remain. The list refreshes about
  every 45 seconds while it's open; changes flash, and if your pick sells out you're told.
- **Book:** pick show + ticket + count → Swiggy's summary and total → **Confirm** →
  free tickets are booked straight away; paid tickets go to UPI. Seats are re-checked just
  before the cart is created.
- **Extras:** venue directions, add to calendar, share, per-person cost, countdown.

### 🗺️ Plan — everything together
Describe the outing: *"Saturday evening for a family of 4 in Koramangala: a comedy show, dinner
out, and snacks to order on the way home, budget ₹5000."* Plan asks at most one question, then
builds an **itinerary timeline** using real results from all four services, with buttons on each
step: **Get tickets** (Scenes picker), **Book this table** (Dineout slot picker),
**Order dinner home** (Food), **Add snacks** (Instamart picks to approve). Plan never books or
pays by itself.

**Live plan panel** (right side on desktop, the Explore drawer on mobile): every step on a timeline
with its live status — planned → searching → options ready → AI pick (with why) → waiting for you →
booked / added (with Swiggy's order id and live status) → done, or failed with the reason and the
AI's replacement. The header shows date, party size, real money paid / lined up vs your budget, a
progress bar and what the AI is doing right now. An **Activity log** lists every action, timestamped.
Tap **Run plan for me** (or type "go ahead" / "do it"): the AI works through the steps by itself —
opens each picker pre-filled with its best pick, proposes dishes / snacks — and **stops at every
booking, cart, order or payment** until you tap Confirm, then carries on. **Pause / Resume**, and per
step **Skip**, **Replan** or **Try again**. If a step fails (sold out, walk-in only, no slots, out of
stock) the AI replans just that step once, automatically. The panel is saved per chat; after a reload
a running plan comes back paused.

### 🧾 History — your orders & bookings
Click **History** at the top. You get:
- Totals: number of orders, amount spent (cancelled excluded), active now, bookings.
- Filters (All / Food / Instamart / Dineout / Scenes) and search.
- **Active now** first, with **Track order** (live status + "Open Swiggy tracking").
- **Food orders** (up to the last 15 Swiggy shares) with restaurant photos; **View details**
  shows each dish with its photo, size/add-ons, price, total paid, payment and address.
  **Reorder** puts the exact same items and sizes back into your Food cart after you confirm.
- **Instamart orders** from the last 15 days (Swiggy only shares 15 days).
- **Bookings** made in Swizzo (tables and tickets) with live status.
- **Help** → Swiggy customer care 080-67466729.

You can also just ask in chat: "my past orders", "my bookings", "is my table confirmed?".

---

## 3. Handy things everywhere
- **Chips** under replies suggest next steps — tap to send.
- **Photo input:** attach a photo of your fridge, a shopping list or a dish; the AI identifies
  it and searches accordingly.
- **Voice:** mic button for speech input; hands-free mode on larger screens.
- **Stop** cancels a reply mid-way.
- **Chats** (top bar) keeps your conversations; **Tools** has diet & allergy preferences,
  budget, calorie/protein goals, recipes, deals and themed baskets.
- **Notifications:** tap **🔔 Notify me** to get a browser notification when an order or
  booking status changes while you're in another tab.
- **Dark mode:** the sun/moon button.

---

## 4. What Swiggy doesn't allow (and what to do instead)

| You want to… | Status | Do this instead |
|---|---|---|
| Cancel or change a Food / Instamart order | Not exposed by Swiggy | Call 080-67466729 |
| See Dineout / Scenes bookings made in the Swiggy app | No list tool exists | Open the Swiggy app (Swizzo lists bookings made in Swizzo) |
| Cancel a Dineout booking | Not enabled for this account yet (button activates automatically if Swiggy enables it) | Dineout app or 080-67466729 |
| Cancel event tickets | Not exposed | Swiggy app / support |
| Instamart coupons, Instamart order details | Documented but not live | — |
| Rate orders, review restaurants, tip or chat with the delivery partner | Not exposed | Swiggy app |
| Pay a Dineout restaurant bill | Not exposed | Swiggy app at the restaurant |
| Use cards / net banking | Only methods Swiggy returns (UPI apps, QR, COD, Swiggy Money) | — |
| Browse Scenes by genre chips | Swiggy's browse returns nothing right now | Swizzo searches by genre keywords instead |

The full technical list (all 62 live tools, what each does, where the app uses it, images it
returns) is in **docs/swiggy-mcp/CAPABILITIES.md**.

---

## 5. Running the app (for developers)

```bash
cd swiggy-chat
npm install
npm run build && npm start     # http://localhost:3000  (use this; `npm run dev` currently
                               # runs out of memory after a few minutes)
npx tsc --noEmit && npm run lint
npx tsx --tsconfig tsconfig.json scripts/verify-coverage.ts   # every live tool is wired
```

Configuration lives in `.env.local` (AI keys, `APP_BASE_URL`, `SESSION_SECRET`,
`SWIGGY_ENABLE_ORDERS=true` to allow real orders/bookings). For going live on a public URL see
**docs/swiggy-mcp/PRODUCTION-ACCESS.md** (what to send Swiggy to allowlist your redirect URL).
