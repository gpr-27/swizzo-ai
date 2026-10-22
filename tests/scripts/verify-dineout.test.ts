// scripts/verify-dineout.ts, run unchanged inside Vitest (each printed check = one test).
import { scriptSuite } from "./runScript";

await scriptSuite("verify-dineout", { exits: "always" });
