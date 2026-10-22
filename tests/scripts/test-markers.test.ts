// scripts/test-markers.ts, run unchanged inside Vitest (each printed check = one test).
import { scriptSuite } from "./runScript";

await scriptSuite("test-markers", { exits: "never" });
