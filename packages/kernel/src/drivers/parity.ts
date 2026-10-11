import type { Json, Program } from "../driver.ts";

/**
 * One behaviour suite every driver must pass. Runner-agnostic: pass in `test`/`expect`
 * from bun:test or vitest. Time is relative (d.now() + ms) so drivers can start anywhere.
 */
export type World = {
  call(instance: string, method: string, args: Json): Promise<Json>;
  advance(ms: number): Promise<void>;
};

/** A Program that exposes the raw driver over onCall, and logs fired timers to its store. */
export const probe: Program = (d, id) => ({
  async onCall(method, args) {
    const a = (args ?? []) as Json[];
    const k = a[0] as string;
    switch (method) {
      case "id":
        return id;
      case "get":
        return d.store.get(k);
      case "put":
        await d.store.put(k, a[1] ?? null, a[2] === undefined ? undefined : { ttlMs: a[2] as number });
        return null;
      case "cas":
        return d.store.cas(k, a[1] as number | null, a[2] ?? null);
      case "take":
        return d.store.take(k);
      case "delete":
        await d.store.delete(k);
        return null;
      case "timer.set":
        await d.timer.set(k, d.now() + (a[1] as number), a[2] ?? null);
        return null;
      case "timer.cancel":
        await d.timer.cancel(k);
        return null;
      case "call":
        return d.call(k, a[1] as string, a[2] ?? null);
      case "fired":
        return ((await d.store.get("fired"))?.value ?? []) as Json;
    }
    throw new Error(`probe: unknown method ${method}`);
  },
  async onTimer(name, payload) {
    const fired = ((await d.store.get("fired"))?.value ?? []) as Json[];
    await d.store.put("fired", [...fired, [name, payload]]);
    if (name === "chain") await d.timer.set("chained", d.now(), null);
    if (name === "boom") throw new Error("boom");
  },
});

type Expect = (v: unknown) => { toBe(x: unknown): void; toEqual(x: unknown): void };

export function parity(name: string, world: () => Promise<World> | World, t: { test: (n: string, fn: () => Promise<void>) => void; expect: Expect }) {
  const { test, expect } = t;

  test(`${name}: get, put, versions, delete`, async () => {
    const w = await world();
    expect(await w.call("a", "get", ["k"])).toBe(null);
    await w.call("a", "put", ["k", { x: 1 }]);
    const r1 = (await w.call("a", "get", ["k"])) as { v: number; value: Json };
    expect(r1.value).toEqual({ x: 1 });
    await w.call("a", "put", ["k", { x: 2 }]);
    const r2 = (await w.call("a", "get", ["k"])) as { v: number; value: Json };
    expect(r2.v > r1.v).toBe(true);
    await w.call("a", "delete", ["k"]);
    expect(await w.call("a", "get", ["k"])).toBe(null);
  });

  test(`${name}: cas, including no ABA after delete`, async () => {
    const w = await world();
    expect(await w.call("a", "cas", ["k", null, 1])).toBe(true);
    expect(await w.call("a", "cas", ["k", null, 2])).toBe(false);
    const { v } = (await w.call("a", "get", ["k"])) as { v: number };
    expect(await w.call("a", "cas", ["k", v, 2])).toBe(true);
    expect(await w.call("a", "cas", ["k", v, 3])).toBe(false);
    const { v: v2 } = (await w.call("a", "get", ["k"])) as { v: number };
    await w.call("a", "delete", ["k"]);
    await w.call("a", "put", ["k", 4]);
    expect(await w.call("a", "cas", ["k", v2, 5])).toBe(false);
    expect(((await w.call("a", "get", ["k"])) as { value: Json }).value).toBe(4);
  });

  test(`${name}: take is once`, async () => {
    const w = await world();
    await w.call("a", "put", ["k", "x"]);
    const both = await Promise.all([w.call("a", "take", ["k"]), w.call("a", "take", ["k"])]);
    expect(both.filter((x) => x === "x").length).toBe(1);
    expect(await w.call("a", "take", ["k"])).toBe(null);
  });

  test(`${name}: ttl`, async () => {
    const w = await world();
    await w.call("a", "put", ["k", 1, 1000]);
    await w.call("a", "put", ["j", 1, 1000]);
    await w.advance(999);
    expect(((await w.call("a", "get", ["k"])) as { value: Json }).value).toBe(1);
    await w.advance(1);
    expect(await w.call("a", "get", ["k"])).toBe(null);
    expect(await w.call("a", "take", ["j"])).toBe(null);
    expect(await w.call("a", "cas", ["k", null, 2])).toBe(true);
  });

  test(`${name}: timers fire in order, replace, cancel, survive errors`, async () => {
    const w = await world();
    await w.call("a", "timer.set", ["late", 300, "l"]);
    await w.call("a", "timer.set", ["boom", 50, null]);
    await w.call("a", "timer.set", ["first", 100, "f"]);
    await w.call("a", "timer.set", ["retry", 200, 1]);
    await w.call("a", "timer.set", ["retry", 150, 2]);
    await w.call("a", "timer.set", ["gone", 120, null]);
    await w.call("a", "timer.cancel", ["gone"]);
    await w.advance(99);
    expect(await w.call("a", "fired", [])).toEqual([["boom", null]]);
    await w.advance(151);
    expect(await w.call("a", "fired", [])).toEqual([["boom", null], ["first", "f"], ["retry", 2]]);
    await w.advance(50);
    expect(((await w.call("a", "fired", [])) as Json[]).at(-1)).toEqual(["late", "l"]);
  });

  test(`${name}: timer set while firing runs in the same advance`, async () => {
    const w = await world();
    await w.call("a", "timer.set", ["chain", 10, null]);
    await w.advance(10);
    expect(await w.call("a", "fired", [])).toEqual([["chain", null], ["chained", null]]);
  });

  test(`${name}: instances are isolated, call reaches the named one`, async () => {
    const w = await world();
    await w.call("a", "put", ["k", "a"]);
    expect(await w.call("b", "get", ["k"])).toBe(null);
    expect(await w.call("a", "call", ["b", "id", null])).toBe("b");
    await w.call("a", "call", ["b", "timer.set", ["t", 10, "via-a"]]);
    await w.advance(10);
    expect(await w.call("b", "fired", [])).toEqual([["t", "via-a"]]);
  });
}
