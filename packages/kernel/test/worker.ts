import { durableObject } from "../src/drivers/do.ts";
import { probe } from "../src/drivers/parity.ts";
import { tools } from "./tools.ts";

// Fake clock, far in the future so real alarms never fire on their own during tests.
// Shared with do.test.ts through globalThis: the worker and tests run in one isolate.
const g = globalThis as { ocNow?: number };
g.ocNow ??= Date.now() + 10 * 365 * 86400_000;

export const PROBE = { binding: "PROBE", db: "DB", now: () => g.ocNow! };
export class Probe extends durableObject(probe, PROBE) {}

// The kernel's tools (#53) on the same platform.
export class Tools extends durableObject(tools, { binding: "TOOLS", now: () => g.ocNow! }) {}
