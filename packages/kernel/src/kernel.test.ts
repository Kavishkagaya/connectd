import { expect, test } from "bun:test";
import { memory } from "./drivers/memory.ts";
import { kernel } from "./kernel.ts";
import { keys, world } from "./testkit.ts";

test("kernel: a stored name is declared once per kind; names are checked", async () => {
  const w = memory((atom, platform) => {
    const k = kernel(atom, platform);
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
  const seen: unknown[][] = [];
  const w = memory((atom, platform) => kernel(atom, platform).serve({}), { log: (...a) => void seen.push(a) });
  const h = kernel({ name: "x" } as never, w.platform).serve({});
  await h.onTimer("ghost", null);
  expect(seen).toEqual([["warn", "kernel.timer.unhandled", { atom: "x", timer: "ghost" }]]);
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
  const k = kernel({ name: "x" } as never, {} as never);
  await expect(k.seal(1)).rejects.toThrow("needs opts.keys");
  expect(() => k.ticket("login", { ttlMs: 1 })).toThrow("needs opts.stateKey");
  expect((await keys()).current).toBe(1);
});
