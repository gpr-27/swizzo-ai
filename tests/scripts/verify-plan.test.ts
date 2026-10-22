// scripts/verify-plan.ts, run unchanged inside Vitest (each printed check = one test).
import { scriptSuite } from "./runScript";

await scriptSuite("verify-plan", { exits: "always" });
