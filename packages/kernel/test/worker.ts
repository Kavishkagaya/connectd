import { durableObject } from "../src/drivers/do.ts";
import { probe } from "../src/drivers/parity.ts";
import { v2 } from "./v2.ts";

// Fake clock, far in the future so real alarms never fire on their own during tests.
// Shared with do.test.ts through globalThis: the worker and tests run in one isolate.
const g = globalThis as { ocNow?: number };
g.ocNow ??= Date.now() + 10 * 365 * 86400_000;

export class Probe extends durableObject(probe, { binding: "PROBE", now: () => g.ocNow! }) {}

// Kernel v2 (#53) on the same driver.
export class V2 extends durableObject(v2, { binding: "V2", now: () => g.ocNow! }) {}
