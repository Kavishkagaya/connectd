import { expect, test } from "bun:test";
import { memory } from "../drivers/memory.ts";
import { kernel } from "./kernel.ts";
import { keys, world } from "./testkit.ts";

test("kernel: a stored name is declared once per kind; names are checked", async () => {
  const w = memory((d, instance) => {
    const k = kernel(d, { instance });
    k.cell("record");
    k.timer("record", { handle: async () => {} }); // another kind may reuse it
    return k.serve({
      twice: async () => (k.cell("record"), null),
      bad: async () => (k.cell("a:b"), null),
      slash: async () => (k.queue("a/b", { deliver: async () => null }), null),
    });
  });
  await expect(w.call("i", "twice", null)).rejects.toThrow("cell record declared twice");
  await expect(w.call("i", "bad", null)).rejects.toThrow("bad cell name");
  await expect(w.call("i", "slash", null)).rejects.toThrow("bad queue name");
});

test("kernel: serve routes methods, refuses unknown and kernel.* ones", async () => {
  const { call } = await world(() => ({ methods: { hello: async (a) => `hi ${String(a)}` } }));
  expect(await call("i", "hello", "you")).toBe("hi you");
  await expect(call("i", "nope")).rejects.toThrow("no method nope");
  await expect(call("i", "kernel.secret")).rejects.toThrow("kernel: no method kernel.secret");
});

test("kernel: a timer nobody declared is dropped with a warning", async () => {
  const { w, get } = await world(() => ({}));
  await get();
  const warn = console.warn;
  const seen: unknown[][] = [];
  console.warn = (...a: unknown[]) => void seen.push(a);
  try {
    const h = kernel({} as never, { instance: "x" }).serve({});
    await h.onTimer("ghost", null);
  } finally {
    console.warn = warn;
  }
  expect(seen[0]?.[2]).toBe("ghost");
  expect(w.now()).toBe(0);
});

test("kernel: seal and unseal; stale after a key rotation", async () => {
  const a = await world((k) => ({ k }), { versions: [1] });
  const { k } = await a.get();
  const sealed = await k.seal({ accessToken: "gho_abc" });
  expect(sealed).not.toContain("gho_abc");
  expect(await k.unseal(sealed)).toEqual({ value: { accessToken: "gho_abc" }, stale: false });
  const b = await world((k) => ({ k }), { versions: [1, 2] });
  const { k: k2 } = await b.get();
  expect(await k2.unseal(sealed)).toEqual({ value: { accessToken: "gho_abc" }, stale: true });
  expect((await k2.unseal(await k2.seal("x"))).stale).toBe(false);
});

test("kernel: tools that need keys say so", async () => {
  const k = kernel({} as never, { instance: "x" });
  await expect(k.seal(1)).rejects.toThrow("needs opts.keys");
  expect(() => k.ticket("login", { ttlMs: 1 })).toThrow("needs opts.stateKey");
  expect((await keys()).current).toBe(1);
});
