// Fixture for the script adapter self-test: an assertion-style crash.
import assert from "node:assert/strict";
assert.equal(1 + 1, 3, "math is broken");
