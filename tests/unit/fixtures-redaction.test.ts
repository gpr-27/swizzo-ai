// Every recorded live capture the tests use must stay free of PII and secrets:
// no full phone numbers, e-mail addresses, bearer tokens / JWTs, or street
// flat numbers (captures use "Test User" and "[flat redacted]").
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { ROOT } from "../fixtures/live";

const DIRS = ["docs/swiggy-mcp/live", "scripts/fixtures", "tests/fixtures"];

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (name.endsWith(".json")) out.push(p);
  }
  return out;
}

const all = DIRS.flatMap((d) => files(join(ROOT, d)));
const PATTERNS: [string, RegExp][] = [
  ["Indian mobile number", /(?<![\d.])(?:\+91[\s-]?)?[6-9]\d{9}(?![\d.])/],
  ["e-mail address", /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.(?:com|in|net|org|co)\b/],
  ["JWT", /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["bearer token", /Bearer\s+[A-Za-z0-9._-]{20,}/i],
];

describe("recorded live fixtures are redacted", () => {
  it("finds the capture files", () => expect(all.length).toBeGreaterThan(30));
  for (const f of all) {
    it(relative(ROOT, f), () => {
      const text = readFileSync(f, "utf8");
      // "9000006256": the capture's zero-filled placeholder (only the last 4 digits kept)
      const scrubbed = text.replace(/\b90000\d{5}\b/g, "<placeholder>");
      for (const [what, re] of PATTERNS) {
        const m = re.exec(scrubbed);
        expect(m?.[0], `${what} in ${relative(ROOT, f)}`).toBeUndefined();
      }
    });
  }
});
