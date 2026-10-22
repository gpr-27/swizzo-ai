// scripts/verify-scenes.ts, run unchanged inside Vitest (each printed check = one test).
import { scriptSuite } from "./runScript";

await scriptSuite("verify-scenes", { exits: "always", env: { SWIGGY_TOKEN: undefined } });
