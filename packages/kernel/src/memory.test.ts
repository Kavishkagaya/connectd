import { expect, test } from "bun:test";
import type { Driver, Json } from "./index.ts";
import { memory } from "./memory.ts";

// A program that exposes the raw driver so tests can poke it.
const fired: [string, string, Json][] = [];
const world = () => {
  const drivers = new Map<string, Driver>();
  const w = memory((d, id) => {
    drivers.set(id, d);
    return {
      async onCall(method, args) {
        if (method === "echo") return { id, args };
        return null;
      },
      async onTimer(name, payload) {
        fired.push([id, name, payload]);
      },
    };
  });
  const driver = async (id: string) => {
    await w.call(id, "noop", null);
    return drivers.get(id)!;
  };
  return { w, driver };
};

test("ttl, take-once, cas", async () => {
  const { w, driver } = world();
  const d = await driver("conn:a");

  await d.store.put("hs:1", { pkce: "x" }, { ttlMs: 1000 });
  await w.advance(999);
  expect(await d.store.take("hs:1")).toEqual({ pkce: "x" });
  expect(await d.store.take("hs:1")).toBeNull();

  await d.store.put("hs:2", 1, { ttlMs: 1000 });
  await w.advance(1000);
  expect(await d.store.get("hs:2")).toBeNull();

  expect(await d.store.cas("rec", null, { t: 1 })).toBe(true);
  expect(await d.store.cas("rec", null, { t: 2 })).toBe(false);
  const rec = await d.store.get("rec");
  expect(await d.store.cas("rec", rec!.v, { t: 2 })).toBe(true);
  expect(await d.store.cas("rec", rec!.v, { t: 3 })).toBe(false);
  expect((await d.store.get("rec"))!.value).toEqual({ t: 2 });

  const obj = { n: 1 };
  await d.store.put("clone", obj);
  obj.n = 2;
  expect((await d.store.get("clone"))!.value).toEqual({ n: 1 });
});

test("timers fire in order, replace and cancel", async () => {
  fired.length = 0;
  const { w, driver } = world();
  const a = await driver("conn:a");
  const b = await driver("conn:b");

  await a.timer.set("refresh", 300, "late");
  await b.timer.set("poll", 100, "b");
  await a.timer.set("retry", 200, 1);
  await a.timer.set("retry", 150, 2); // replaces
  await a.timer.set("gone", 120);
  await a.timer.cancel("gone");

  await w.advance(250);
  expect(fired).toEqual([
    ["conn:b", "poll", "b"],
    ["conn:a", "retry", 2],
  ]);
  expect(w.now()).toBe(250);
  await w.advance(100);
  expect(fired.at(-1)).toEqual(["conn:a", "refresh", "late"]);
});

test("call reaches another instance", async () => {
  const { driver } = world();
  const a = await driver("conn:a");
  expect(await a.call("app:github", "echo", { x: 1 })).toEqual({ id: "app:github", args: { x: 1 } });
});
