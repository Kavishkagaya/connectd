import { expect, test } from "bun:test";
import { world } from "./testkit.ts";

type Rec = { n: number; state?: string };

test("cell: read, update, no change, value after", async () => {
  const { get } = await world((k) => ({ c: k.cell<Rec>("rec") }));
  const { c } = await get();
  expect(await c.read()).toBeNull();
  expect(await c.update((cur) => ({ n: (cur?.n ?? 0) + 1 }))).toEqual({ n: 1 });
  const r = await c.read();
  expect(r?.value).toEqual({ n: 1 });
  expect(await c.update(() => null)).toEqual({ n: 1 });
  expect((await c.read())?.v).toBe(r!.v); // null wrote nothing
});

test("cell: parallel updates all land (read-decide-cas loop)", async () => {
  const { get } = await world((k) => ({ c: k.cell<Rec>("rec") }));
  const { c } = await get();
  await Promise.all(Array.from({ length: 10 }, () => c.update((cur) => ({ n: (cur?.n ?? 0) + 1 }))));
  expect((await c.read())?.value.n).toBe(10);
});

test("cell: f runs again on fresh data when another write gets in first", async () => {
  const { get } = await world((k) => ({ c: k.cell<Rec>("rec") }));
  const { c } = await get();
  await c.put({ n: 0, state: "active" });
  const seen: string[] = [];
  // Both read "active"; the revoke's cas lands first, so the refresh's cas loses and its f runs
  // again on the fresh value, sees "revoked", and backs off instead of undoing the revoke.
  const revoke = c.update((cur) => ({ ...cur!, state: "revoked" }));
  const refresh = c.update((cur) => {
    seen.push(cur!.state!);
    return cur!.state === "active" ? { ...cur!, n: 1 } : null;
  });
  await Promise.all([revoke, refresh]);
  expect((await c.read())?.value).toEqual({ n: 0, state: "revoked" });
  expect(seen).toEqual(["active", "revoked"]);
});

test("cell: a throw in f writes nothing; an async f is refused", async () => {
  const { get } = await world((k) => ({ c: k.cell<Rec>("rec") }));
  const { c } = await get();
  await c.put({ n: 1 });
  await expect(
    c.update(() => {
      throw new Error("illegal move");
    }),
  ).rejects.toThrow("illegal move");
  // @ts-expect-error f must be synchronous
  await expect(c.update(async () => ({ n: 2 }))).rejects.toThrow("synchronous");
  expect((await c.read())?.value).toEqual({ n: 1 });
});

test("cell: emit saves messages with the change; only the attempt that lands counts", async () => {
  const { get } = await world((k) => ({ c: k.cell<Rec, { to: string }>("rec") }));
  const { c } = await get();
  await c.update((_, emit) => (emit({ to: "active" }), { n: 1, state: "active" }));
  // Two racing changes: the loser's first attempt emits, then retries; its stale message must not stay.
  await Promise.all([
    c.update((cur, emit) => (emit({ to: `a${cur!.n}` }), { ...cur!, n: cur!.n + 1 })),
    c.update((cur, emit) => (emit({ to: `b${cur!.n}` }), { ...cur!, n: cur!.n + 1 })),
  ]);
  expect((await c.read())?.value).toEqual({ n: 3, state: "active" }); // read hides the envelope
  const out = await c.outbox.pending();
  expect(out.map((i) => i.seq)).toEqual([1, 2, 3]);
  expect(out.map((i) => i.msg.to)).toEqual(["active", "a1", "b2"]);
  await c.outbox.ack(2);
  expect((await c.outbox.pending()).map((i) => i.seq)).toEqual([3]);
  await c.put({ n: 9 }); // put keeps the outbox
  expect((await c.outbox.pending()).map((i) => i.seq)).toEqual([3]);
  await c.update((cur, emit) => (emit({ to: "x" }), cur));
  expect((await c.outbox.pending()).map((i) => i.seq)).toEqual([3, 4]); // seq has no gaps
});

test("cell: ttl and delete", async () => {
  const { get, w } = await world((k) => ({ c: k.cell<Rec>("rec", { ttlMs: 1000 }) }));
  const { c } = await get();
  await c.put({ n: 1 });
  await w.advance(999);
  expect(await c.read()).not.toBeNull();
  await w.advance(1);
  expect(await c.read()).toBeNull();
  await c.put({ n: 2 });
  await c.delete();
  expect(await c.read()).toBeNull();
});

test("cell: survives a restart", async () => {
  const a = await world((k) => ({ c: k.cell<Rec, string>("rec") }));
  await (await a.get()).c.update((_, emit) => (emit("hi"), { n: 1 }));
  const b = await world((k) => ({ c: k.cell<Rec, string>("rec") }), { snapshot: a.w.dump() });
  const { c } = await b.get();
  expect((await c.read())?.value).toEqual({ n: 1 });
  expect(await c.outbox.pending()).toEqual([{ seq: 1, msg: "hi" }]);
});
