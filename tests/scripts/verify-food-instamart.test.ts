// scripts/verify-food-instamart.ts, run unchanged inside Vitest (each printed check = one test).
import { scriptSuite } from "./runScript";

await scriptSuite("verify-food-instamart", { exits: "never" });
