import { expect, test } from "bun:test";
import type { Json } from "../driver.ts";
import { memory, type MemoryOptions } from "./memory.ts";
import { parity, probe } from "./parity.ts";

const world = (o: MemoryOptions = {}) => {
  const m = memory(probe, o);
  return { ...m, restart: () => world({ ...o, now: m.now(), snapshot: JSON.parse(JSON.stringify(m.dump())) }) };
};

parity("memory", () => world(), { test, expect });
// A clock that doesn't move on its own: the real-clock mode with advance() as a skew on top.
parity("memory (clock)", () => memory(probe, { clock: () => 1_000 }), { test, expect });

// Memory-only: with a moving clock, timers fire on their own (the DO's real alarms, which the DO
// parity run keeps off with a far-future fake clock).
test("memory (clock): timers fire on their own, also after a restart", async () => {
  let w = memory(probe, { clock: Date.now });
  await w.call("a", "timer.set", ["soon", 20, 1]);
  await w.call("a", "timer.set", ["later", 60, 2]);
  await Bun.sleep(40);
  expect(await w.call("a", "fired", [])).toEqual([["soon", 1]]);
  w = memory(probe, { clock: Date.now, snapshot: w.dump() });
  await Bun.sleep(40);
  expect((await w.call("a", "fired", [])) as Json).toEqual([["soon", 1], ["later", 2]]);
  await w.call("a", "timer.set", ["stopped", 10, 3]);
  await w.stop();
  await Bun.sleep(30);
  expect(((await w.call("a", "fired", [])) as Json[]).length).toBe(2);
  expect(Object.keys(w.dump().a?.timers ?? {})).toEqual(["stopped"]);
});
