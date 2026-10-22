// scripts/test-live-features.ts, run unchanged inside Vitest (each printed check = one test).
import { scriptSuite } from "./runScript";

await scriptSuite("test-live-features", { exits: "never" });
