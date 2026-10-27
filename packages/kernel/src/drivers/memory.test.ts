import { expect, test } from "bun:test";
import type { Handler, Json, Program } from "../platform.ts";
import { memory, type MemoryOptions } from "./memory.ts";
import { PARITY_ENV, parity, platformParity, probe, type World } from "./parity.ts";

const quiet = () => {}; // the parity suite makes timers and deferred work fail on purpose
const world = (o: MemoryOptions = {}): World => {
  const m = memory(probe, { env: PARITY_ENV, log: quiet, ...o });
  return {
    ...m,
    cut: (name, on) => void (on ? m.unreachable.add(name) : m.unreachable.delete(name)),
    restart: () => world({ ...o, now: m.now(), snapshot: JSON.parse(JSON.stringify(m.dump())) }),
  };
};

parity("memory", () => world(), { test, expect });
// A clock that doesn't move on its own: the real-clock mode with advance() as a skew on top.
// No restart: a restart keeps the fake clock, not a skew.
parity("memory (clock)", () => ({ ...world({ clock: () => 1_000 }), restart: undefined }) as World, { test, expect });
platformParity("memory", () => world(), { test, expect });

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

let fired: string[] = [];
// A handler that throws synchronously (not a rejected promise) must not stop later timers, in either mode.
const sync: Program = (d) => ({
  onCall: async (_m, a) => {
    for (const [name, ms] of a as [string, number][]) await d.timer.set(name, d.now() + ms);
    return null;
  },
  onTimer: ((name: string) => {
    if (name === "throws") throw new Error("sync throw");
    fired.push(name);
  }) as unknown as Handler["onTimer"], // deliberately not async
});

test("memory: a synchronously throwing timer doesn't stop later ones (fake clock and clock mode)", async () => {
  fired = [];
  const w = memory(sync, { log: quiet });
  await w.call("a", "set", [["throws", 10], ["after", 20]]);
  await w.advance(20);
  expect(fired).toEqual(["after"]);
  await w.call("a", "set", [["throws", 10], ["again", 20]]);
  await w.advance(20);
  expect(fired).toEqual(["after", "again"]);

  fired = [];
  const r = memory(sync, { clock: Date.now, log: quiet });
  await r.call("a", "set", [["throws", 5], ["after", 15]]);
  await Bun.sleep(40);
  expect(fired).toEqual(["after"]);
  await r.call("a", "set", [["throws", 5], ["again", 15]]);
  await Bun.sleep(40);
  expect(fired).toEqual(["after", "again"]);
  await r.stop();
});
