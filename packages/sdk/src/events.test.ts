import { expect, test } from "bun:test";
import { type ConnectionEvent, type EventOf, sign } from "./index.ts";
import { SECRET, setup, T0 } from "./testing.ts";

const H = 3_600_000;

/** The runtime delivering to an SDK events handler. `got` = every attempt, as the runtime saw it. */
async function wired(o: { dedupe?: Set<string> } = {}) {
  const t = await setup();
  const ev = t.oc.events({ secret: SECRET, now: t.w.now, ...(o.dedupe ? { dedupe: o.dedupe } : {}) });
  const got: { id: string; status: number; body: string; headers: Headers }[] = [];
  let target = ev;
  t.receiver(async (req) => {
    const copy = req.clone();
    const res = await target.handle(req);
    got.push({ id: req.headers.get("webhook-id")!, status: res.status, body: await copy.text(), headers: new Headers(req.headers) });
    return res;
  });
  return { ...t, ev, got, use: (e: typeof ev) => void (target = e) };
}

test("real deliveries: typed dispatch, the connection as a client, ack ends delivery", async () => {
  const t = await wired();
  const seen: string[] = [];
  t.ev
    .on("connection.active", async (e, conn) => {
      const typed: EventOf<"connection.active"> = e;
      seen.push(`${typed.type} ${typed.data.from}->${typed.data.to}`);
      // Handlers can call back into the runtime through their connection. It's the state now: the event is history.
      expect((await conn.status()).state).toBe("revoked");
      expect([conn.def, conn.id]).toEqual(["keyed", "k1"]);
    })
    .on("webhook.push", (e) => void seen.push(`webhook ${JSON.stringify(e.data)}`))
    .on("*", (e: ConnectionEvent) => void seen.push(`* ${e.id}`));

  await t.oc.connection("keyed", "k1").connect({ key: "sk" });
  await t.oc.connection("keyed", "k1").call("hook", { topic: "push", delivery: "d1", payload: { n: 1 } });
  await t.oc.connection("keyed", "k1").revoke(); // no handler for this type: still acked
  await t.w.advance(0);
  expect(seen).toEqual([
    "connection.active null->active",
    "* conn:keyed:k1:1",
    'webhook {"topic":"push","delivery":"d1","payload":{"n":1}}',
    "* conn:keyed:k1:2",
    "* conn:keyed:k1:3",
  ]);
  expect(t.got.map((g) => g.status)).toEqual([204, 204, 204]);
  await t.w.advance(24 * H);
  expect(t.got.length).toBe(3);
});

test("bad signature, wrong secret, stale timestamp: 401, and the runtime keeps retrying", async () => {
  const t = await wired();
  await t.oc.connection("keyed", "k1").connect({ key: "sk" });
  await t.w.advance(0);
  const { body, headers } = t.got[0]!;
  const post = (h: Headers, b = body) => t.ev.handle(new Request("https://app.test/events", { method: "POST", headers: h, body: b }));
  expect((await post(headers)).status).toBe(204);
  expect((await post(headers, body.replace("active", "revoked"))).status).toBe(401);
  expect((await post(new Headers({ "content-type": "application/json" }))).status).toBe(401);
  const stale = t.oc.events({ secret: SECRET, now: () => T0 + 301_000 });
  expect((await stale.handle(new Request("https://app.test/events", { method: "POST", headers, body }))).status).toBe(401);
  expect((await t.ev.handle(new Request("https://app.test/events"))).status).toBe(405);

  // A receiver configured with another secret refuses every delivery; the event stays queued.
  const wrong = t.oc.events({ secret: `whsec_${btoa("x".repeat(32))}`, now: t.w.now });
  t.use(wrong);
  await t.oc.connection("keyed", "k1").revoke();
  await t.w.advance(0);
  t.use(t.ev);
  await t.w.advance(H);
  expect(t.got.map((g) => [g.id, g.status])).toEqual([
    ["conn:keyed:k1:1", 204],
    ["conn:keyed:k1:2", 401],
    ["conn:keyed:k1:2", 204],
  ]);
});

test("a throwing handler answers 500; the retry carries the same id, in order", async () => {
  const t = await wired();
  let fail = true;
  const order: number[] = [];
  t.ev.on("*", (e) => {
    if (fail) throw new Error("db down");
    order.push(e.seq);
  });
  const err = console.error;
  console.error = () => {};
  try {
    await t.oc.connection("keyed", "k1").connect({ key: "sk" });
    await t.oc.connection("keyed", "k1").revoke();
    await t.w.advance(0);
    expect(t.got.map((g) => [g.id, g.status])).toEqual([["conn:keyed:k1:1", 500]]); // parked behind the failure
  } finally {
    console.error = err;
  }
  fail = false;
  await t.w.advance(10_000);
  expect(t.got.map((g) => [g.id, g.status])).toEqual([
    ["conn:keyed:k1:1", 500],
    ["conn:keyed:k1:1", 204],
    ["conn:keyed:k1:2", 204],
  ]);
  expect(order).toEqual([1, 2]);
});

test("dedupe on webhook-id: a redelivery is acked without running handlers; a failure isn't recorded", async () => {
  const dedupe = new Set<string>();
  const t = await wired({ dedupe });
  let runs = 0;
  let fail = false;
  t.ev.on("connection.active", () => {
    runs++;
    if (fail) throw new Error("no");
  });
  await t.oc.connection("keyed", "k1").connect({ key: "sk" });
  await t.w.advance(0);
  expect([runs, [...dedupe]]).toEqual([1, ["conn:keyed:k1:1"]]);

  // The same delivery again (a lost ack), re-signed at a later attempt time.
  const { body } = t.got[0]!;
  const again = async (id: string) => {
    const ts = Math.floor(t.w.now() / 1000);
    const headers = { "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": await sign(SECRET, id, ts, body) };
    return (await t.ev.handle(new Request("https://app.test/events", { method: "POST", headers, body }))).status;
  };
  expect(await again("conn:keyed:k1:1")).toBe(204);
  expect(runs).toBe(1);

  fail = true;
  const err = console.error;
  console.error = () => {};
  expect(await again("conn:keyed:k1:9")).toBe(500);
  console.error = err;
  expect(dedupe.has("conn:keyed:k1:9")).toBe(false);
});
