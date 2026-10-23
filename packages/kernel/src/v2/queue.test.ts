import { expect, test } from "bun:test";
import type { Json } from "../driver.ts";
import type { Cell } from "./cell.ts";
import type { Kernel } from "./kernel.ts";
import { type Delivery, QueueError, type QueueOptions } from "./queue.ts";
import { world } from "./testkit.ts";

type Msg = { type: string; body?: string };

/** A receiver that can be switched down; records every attempt. */
function receiver() {
  const r = {
    up: true,
    got: [] as Delivery<Msg>[],
    tries: 0,
    deliver: async (m: Delivery<Msg>) => {
      r.tries++;
      if (!r.up) return "HTTP 503";
      r.got.push(m);
      return null;
    },
  };
  return r;
}

async function setup(o: Partial<QueueOptions<Msg>> = {}) {
  const rx = receiver();
  const wd = await world((k: Kernel) => ({
    k,
    q: k.queue<Msg>("events", { deliver: rx.deliver, retry: { baseMs: 1000, maxMs: 8000 }, summary: (m) => m.type, ...o }),
    rec: k.cell<{ state: string }, Msg>("record"),
  }));
  const i = await wd.get("conn:github:a");
  return { ...wd, ...i, rx };
}

test("queue: push delivers in order from the timer, with ids and seqs", async () => {
  const { w, q, rx } = await setup();
  await q.push([{ type: "a" }, { type: "b" }]);
  expect(rx.got).toEqual([]); // pushing never waits for delivery
  await w.advance(0);
  expect(rx.got.map((m) => [m.id, m.seq, m.msg.type])).toEqual([
    ["conn:github:a:events:1", 1, "a"],
    ["conn:github:a:events:2", 2, "b"],
  ]);
  expect((await q.status()).pending).toBe(0);
});

test("queue: a failure parks the line in order, retries with growing waits, then catches up", async () => {
  const { w, q, rx } = await setup();
  rx.up = false;
  await q.push([{ type: "a" }, { type: "b" }]);
  await w.advance(0);
  let s = await q.status();
  expect([s.pending, s.attempt, s.error]).toEqual([2, 1, "HTTP 503"]);
  expect(s.retryAt).toBeGreaterThan(0);
  await q.push([{ type: "c" }]); // adding still works while parked
  for (let i = 0; i < 4; i++) await w.advance(1000);
  expect(rx.tries).toBeGreaterThan(1);
  expect(rx.got).toEqual([]);
  rx.up = true;
  await w.advance(20_000);
  expect(rx.got.map((m) => m.msg.type)).toEqual(["a", "b", "c"]);
  s = await q.status();
  expect([s.pending, s.attempt, s.error, s.retryAt]).toEqual([0, 0, null, null]);
});

test("queue: a throwing deliver counts as a failure", async () => {
  const { w, q } = await setup({
    deliver: async () => {
      throw new Error("network error");
    },
  });
  const err = console.error;
  console.error = () => {};
  await q.push([{ type: "a" }]);
  await w.advance(0);
  console.error = err;
  expect((await q.status()).error).toBe("network error");
});

test("queue: flush skips a parked head's wait", async () => {
  const { w, q, rx } = await setup({ retry: { baseMs: 3_600_000 } });
  rx.up = false;
  await q.push([{ type: "a" }]);
  await w.advance(0);
  rx.up = true;
  await w.advance(1000);
  expect(rx.got).toEqual([]);
  const s = await q.flush();
  expect(s.retryAt).toBeNull();
  expect(s.attempt).toBe(1); // the count stays, so a new failure continues the backoff
  await w.advance(0);
  expect(rx.got.map((m) => m.msg.type)).toEqual(["a"]);
});

test("queue: relay moves a cell's outbox exactly once, before later pushes", async () => {
  const { w, q, rec, rx } = await setup();
  await rec.update((_, emit) => (emit({ type: "connection.active" }), { state: "active" }));
  await q.relay(rec);
  await q.relay(rec); // nothing new
  await q.push([{ type: "webhook" }]);
  await rec.update((_, emit) => (emit({ type: "connection.revoked" }), { state: "revoked" }));
  await q.relay(rec);
  await w.advance(0);
  expect(rx.got.map((m) => [m.seq, m.msg.type])).toEqual([
    [1, "connection.active"],
    [2, "webhook"],
    [3, "connection.revoked"],
  ]);
  expect(await rec.outbox.pending()).toEqual([]);
});

test("queue: a crash between relay's commit and its ack repeats nothing", async () => {
  const { w, q, rec, rx } = await setup();
  await rec.update((_, emit) => (emit({ type: "one" }), { state: "active" }));
  // The ack is lost once (the instance died after the queue's commit).
  let failAck = true;
  const flaky: Cell<{ state: string }, Msg> = {
    ...rec,
    outbox: {
      pending: rec.outbox.pending,
      async ack(seq) {
        if (failAck) {
          failAck = false;
          throw new Error("crash");
        }
        return rec.outbox.ack(seq);
      },
    },
  };
  await expect(q.relay(flaky)).rejects.toThrow("crash");
  expect(await rec.outbox.pending()).toHaveLength(1); // still in the cell…
  await q.relay(flaky); // …so the next relay only acks it
  await w.advance(0);
  expect(rx.got.map((m) => m.msg.type)).toEqual(["one"]);
  expect(await rec.outbox.pending()).toEqual([]);
});

test("queue: parallel pushes never share a slot", async () => {
  const { w, q, rx } = await setup();
  await Promise.all(Array.from({ length: 10 }, (_, i) => q.push([{ type: `m${i}` }])));
  await w.advance(0);
  expect(rx.got.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  expect(new Set(rx.got.map((m) => m.msg.type)).size).toBe(10);
});

test("queue: history keeps the newest done; big bodies keep a summary only; redeliver copies", async () => {
  const { w, q, rx } = await setup({ keep: 3, keepBodyBytes: 200 });
  await q.push([{ type: "a" }, { type: "b" }, { type: "big", body: "x".repeat(500) }, { type: "d" }]);
  await w.advance(0);
  const s = await q.status();
  expect(s.recent.map((r) => [r.slot, r.summary, r.redeliverable])).toEqual([
    [4, "d", true],
    [3, "big", false],
    [2, "b", true],
  ]);
  expect(s.recent[0]?.deliveredAt).toBe(0);
  await expect(q.redeliver(1)).rejects.toMatchObject({ code: "not_found" }); // out of the window
  await expect(q.redeliver(3)).rejects.toMatchObject({ code: "payload_not_retained" });
  await expect(q.redeliver(9)).rejects.toBeInstanceOf(QueueError);
  expect(await q.redeliver(2)).toEqual({ slot: 5 });
  await w.advance(0);
  const copy = rx.got.at(-1)!;
  const orig = rx.got.find((m) => m.seq === 2)!;
  expect(copy).toEqual(orig); // same id, seq and body
  await q.push([{ type: "e" }]);
  await w.advance(0);
  expect(rx.got.at(-1)?.seq).toBe(5); // seqs stay gapless: the copy took a slot, not a seq
  expect((await q.status()).recent[1]?.copy).toBe(true);
});

test("queue: past max the oldest are dropped and marked", async () => {
  const { w, q, rx } = await setup({ max: 2 });
  rx.up = false;
  await q.push([{ type: "a" }, { type: "b" }, { type: "c" }]);
  const s = await q.status();
  expect(s.pending).toBe(2);
  expect(s.recent.map((r) => [r.summary, r.dropped])).toEqual([["a", true]]);
  rx.up = true;
  await w.advance(10_000);
  expect(rx.got.map((m) => m.msg.type)).toEqual(["b", "c"]);
});

test("queue: survives a restart, parked head included", async () => {
  const rx = receiver();
  rx.up = false;
  const setupQ = (k: Kernel) => ({ q: k.queue<Msg>("events", { deliver: rx.deliver, retry: { baseMs: 1000 } }) });
  const a = await world(setupQ);
  await (await a.get()).q.push([{ type: "a" }, { type: "b" }]);
  await a.w.advance(0);
  rx.up = true;
  const b = await world(setupQ, { snapshot: a.w.dump() });
  await b.get();
  await b.w.advance(10_000); // the retry timer was restored with the snapshot
  expect(rx.got.map((m) => m.msg.type)).toEqual(["a", "b"]);
});

test("queue: custom ids", async () => {
  const { w, q, rx } = await setup({ id: (seq) => `evt_${seq}` });
  await q.push([{ type: "a" }]);
  await w.advance(0);
  expect(rx.got[0]?.id).toBe("evt_1");
  const j: Json = rx.got[0] as unknown as Json;
  expect(j).toBeTruthy();
});
