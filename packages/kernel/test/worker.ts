import { durableObject } from "../src/do.ts";
import { probe } from "../src/parity.ts";

// Fake clock, far in the future so real alarms never fire on their own during tests.
// Shared with do.test.ts through globalThis: the worker and tests run in one isolate.
const g = globalThis as { ocNow?: number };
g.ocNow ??= Date.now() + 10 * 365 * 86400_000;

export class Probe extends durableObject(probe, { binding: "PROBE", now: () => g.ocNow! }) {}

