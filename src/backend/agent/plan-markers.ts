// Plan-tab + isolation markers, pulled out of a reply before the generic
// marker parser runs (agent.ts emitAssistantText):
//   PLAN TITLE: <name>
//   ITINERARY: <time> | <service> | <title> | <detail> | <id or ->   (one per stop)
//   HANDOFF: <tab id> | <short ask>   (an off-domain ask → open the owning tab)
// Pure string → data, so scripts/verify-plan.ts can exercise it directly.

import {
  SERVICES,
  SERVICE_META,
  type Itinerary,
  type ItineraryDomain,
  type ItineraryStep,
  type Service,
  type ServiceHandoff,
} from "@/shared/types";

// Words a model may use for each step's service (the prompt asks for the ids).
const DOMAIN_ALIASES: Record<string, ItineraryDomain> = {
  scenes: "scenes",
  scene: "scenes",
  event: "scenes",
  events: "scenes",
  show: "scenes",
  movie: "scenes",
  dineout: "dineout",
  "dine-out": "dineout",
  "dine out": "dineout",
  dining: "dineout",
  restaurant: "dineout",
  table: "dineout",
  food: "food",
  delivery: "food",
  "food delivery": "food",
  instamart: "instamart",
  grocery: "instamart",
  groceries: "instamart",
  snacks: "instamart",
  other: "other",
  mall: "other",
  travel: "other",
  shopping: "other",
};

function asDomain(raw: string | undefined): ItineraryDomain | null {
  if (!raw) return null;
  return DOMAIN_ALIASES[raw.trim().toLowerCase().replace(/[*_`]/g, "")] ?? null;
}

function asService(raw: string | undefined): Service | null {
  const v = (raw ?? "").trim().toLowerCase().replace(/[*_`"']/g, "");
  if ((SERVICES as string[]).includes(v)) return v as Service;
  const alias = asDomain(v);
  return alias && alias !== "other" ? alias : null;
}

function tidy(s: string | undefined, max: number): string {
  return (s ?? "")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** A real-looking card id, or undefined for "-", "none", prose, etc. */
function asRef(raw: string | undefined): string | undefined {
  const v = (raw ?? "").trim().replace(/^(?:id|ref)\s*[=:]\s*/i, "").replace(/[`"']/g, "");
  return /^[A-Za-z0-9_-]{3,80}$/.test(v) && !/^(?:none|null|na|n\/a)$/i.test(v) ? v : undefined;
}

/** Parse one ITINERARY line body ("4:00 PM | scenes | Title | detail | id"). */
export function parseItineraryLine(body: string): ItineraryStep | null {
  const parts = body.split("|").map((p) => p.trim());
  if (parts.length < 2) return null;
  // Expected order: time | service | title | detail | id. Tolerate a missing
  // time (service first) — never guess a service the model didn't name.
  let time: string | undefined;
  let rest: string[];
  let domain = asDomain(parts[1]);
  if (domain) {
    time = parts[0];
    rest = parts.slice(2);
  } else if ((domain = asDomain(parts[0]))) {
    rest = parts.slice(1);
  } else {
    return null;
  }
  const title = tidy(rest[0], 90);
  if (!title) return null;
  const step: ItineraryStep = { domain, title };
  const t = tidy(time, 24);
  if (t && t !== "-") step.time = t;
  const detail = tidy(rest[1], 160);
  if (detail && detail !== "-") step.detail = detail;
  const ref = domain === "other" ? undefined : asRef(rest[2]);
  if (ref) step.ref = ref;
  return step;
}

/**
 * Parse a PLAN INFO line body ("Sat 25 Oct | 4 people | ₹5000"). Parts may come
 * in any order; a "-" or unreadable part is left out (never guessed).
 */
export function parsePlanInfo(body: string): Pick<Itinerary, "date" | "party" | "budget"> {
  const out: Pick<Itinerary, "date" | "party" | "budget"> = {};
  for (const raw of body.split("|")) {
    const p = tidy(raw, 60);
    if (!p || p === "-") continue;
    if (/₹|\brs\.?\b|\binr\b|budget/i.test(p)) {
      const n = Number(p.replace(/,/g, "").match(/\d+(?:\.\d+)?/)?.[0]);
      if (Number.isFinite(n) && n > 0 && n <= 1_000_000) out.budget = Math.round(n);
    } else if (/\b(?:people|persons?|guests?|adults?|kids?|children|pax|friends|of us)\b/i.test(p) || /^\d{1,2}$/.test(p)) {
      const n = (p.match(/\d+/g) ?? []).map(Number).reduce((a, b) => a + b, 0);
      if (n > 0 && n <= 50) out.party = n;
    } else if (!out.date) {
      out.date = tidy(p, 40);
    }
  }
  return out;
}

export interface PlanMarkers {
  /** the reply with these marker lines removed */
  rest: string;
  itinerary: Itinerary | null;
  handoffs: ServiceHandoff[];
}

const LEAD = String.raw`^[ \t>*-]*(?:\*\*)?`;
const TAIL = String.raw`(?:\*\*)?:?(?:\*\*)?[ \t]*`;

/**
 * Pull PLAN TITLE / ITINERARY / HANDOFF lines out of `text`. Hand-offs to the
 * tab the reply came from (`fromService`) are dropped — they'd be a no-op.
 */
export function extractPlanMarkers(text: string, fromService?: Service): PlanMarkers {
  let title: string | undefined;
  const steps: ItineraryStep[] = [];
  const handoffs: ServiceHandoff[] = [];

  let rest = text.replace(new RegExp(`${LEAD}PLAN\\s*TITLE${TAIL}([^\\n]*)$`, "gim"), (_m, t: string) => {
    const v = tidy(t, 80);
    if (v) title = v;
    return "";
  });

  let info: Pick<Itinerary, "date" | "party" | "budget"> = {};
  rest = rest.replace(new RegExp(`${LEAD}PLAN\\s*INFO${TAIL}([^\\n]*)$`, "gim"), (_m, body: string) => {
    info = parsePlanInfo(body);
    return "";
  });

  const unavailable: { what: string; why: string }[] = [];
  rest = rest.replace(new RegExp(`${LEAD}UNAVAILABLE${TAIL}([^\\n]*)$`, "gim"), (_m, body: string) => {
    const [whatRaw, ...whyParts] = body.split("|");
    const what = tidy(whatRaw, 60);
    const why = tidy(whyParts.join("|"), 160);
    if (what && why && unavailable.length < 4) unavailable.push({ what, why });
    return "";
  });

  rest = rest.replace(new RegExp(`${LEAD}ITINERARY${TAIL}([^\\n]*)$`, "gim"), (_m, body: string) => {
    // "ITINERARY: Family Saturday" with no pipes = a title line, not a step.
    if (!body.includes("|")) {
      const v = tidy(body, 80);
      if (v && !title) title = v;
      return "";
    }
    const step = parseItineraryLine(body);
    if (step && steps.length < 12) steps.push(step);
    return "";
  });

  rest = rest.replace(new RegExp(`${LEAD}HANDOFF${TAIL}([^\\n]*)$`, "gim"), (_m, body: string) => {
    const [svcRaw, ...askParts] = body.split("|");
    const service = asService(svcRaw);
    const query = tidy(askParts.join("|"), 200);
    if (
      service &&
      query &&
      service !== fromService &&
      !handoffs.some((h) => h.service === service)
    ) {
      handoffs.push({ service, query, label: `Open in ${SERVICE_META[service].label}` });
    }
    return "";
  });

  return {
    rest: rest.replace(/\n{3,}/g, "\n\n"),
    itinerary: steps.length ? { ...(title ? { title } : {}), ...info, ...(unavailable.length ? { unavailable } : {}), steps } : null,
    handoffs,
  };
}
