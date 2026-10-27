import { expect, test } from "bun:test";
import { apiKey, defineConnection } from "@kavishkagaya/connectd-connections";
import { type Atom, importHmacKey, importKeys, type Json, type Program } from "@kavishkagaya/connectd-kernel";
import { memory } from "@kavishkagaya/connectd-kernel/memory";
import { BODY_KEPT, type ConnectionEvent, directory, emit, events, type EventsStatus, type Extension, KEPT, proxy, runtime } from "./index.ts";
import { sign, verify } from "./signature.ts";

const key = (n: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(n)));
const SECRET = `whsec_${key(7)}`;
const URL_ = "https://app.test/events";
const keyed = defineConnection({ id: "keyed", auth: apiKey(["key"]) });

// A webhook extension stand-in (#25): a method that emits a non-lifecycle event.
const hook: Extension = { connection: (h) => ({ methods: { hook: async (a) => (await emit(h, a, `webhook.${(a as { topic?: string } | null)?.topic ?? "push"}`), null) } }) };

/** The DO limit on one stored value, plus a count of live event keys and of credential-record reads. */
const LIMIT = 2 * 1024 * 1024;
function checked(program: Program) {
  const live = new Set<string>();
  const reads = { record: 0, bodies: 0 };
  const wrapped: Program = (d, platform) => {
    const fit = (k: string, v: Json) => {
      if (JSON.stringify(v).length > LIMIT) throw new Error(`value too large: ${k}`);
      if (k.startsWith("q:events/e/")) live.add(k);
    };
    const store: Atom["store"] = {
      ...d.store,
      get: (k) => (k === "c:record" && reads.record++, k.startsWith("q:events/e/") && reads.bodies++, d.store.get(k)),
      put: (k, v, o) => (fit(k, v), d.store.put(k, v, o)),
      cas: (k, e, v, o) => (fit(k, v), d.store.cas(k, e, v, o)),
      delete: (k) => (live.delete(k), d.store.delete(k)),
    };
    return program({ ...d, store }, platform);
  };
  return { wrapped, live, reads };
}

async function setup(opts: { configured?: boolean } = {}) {
  // Every attempt, failed ones too; `delivered` is the 2xx ones.
  const got: { headers: Headers; body: string; status: number }[] = [];
  let status = 200;
  let hang = false;
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe(URL_);
    expect(init?.redirect).toBe("manual");
    if (hang) throw new DOMException("timed out", "TimeoutError");
    got.push({ headers: new Headers(init?.headers), body: init?.body as string, status });
    return new Response(null, { status });
  }) as typeof globalThis.fetch;
  const settings = {
    keys: await importKeys({ 1: key(1) }, 1),
    stateKey: await importHmacKey(key(9)),
    apiKey: "secret",
    redirectUri: "https://oc.test/callback",
    config: { keyed: null },
    ...(opts.configured === false ? {} : { events: { url: URL_, secret: SECRET } }),
  };
  const rt = runtime({ definitions: { keyed }, settings: async () => settings, extensions: [events(), hook] });
  const c = checked(rt.program);
  const w = memory(c.wrapped, { fetch, now: 1_700_000_000_000 });
  const call = (m: string, a: Json = null) => w.call("conn:keyed:k1", m, a);
  const delivered = () => got.filter((g) => g.status < 300);
  const bodies = () => delivered().map((g) => JSON.parse(g.body) as ConnectionEvent);
  return {
    w,
    call,
    got,
    live: c.live,
    reads: c.reads,
    delivered,
    bodies,
    types: () => bodies().map((e) => e.type),
    set: (s: number, h = false) => ((status = s), (hang = h)),
  };
}

test("lifecycle events are delivered in order, signed, then dropped", async () => {
  const t = await setup();
  await t.call("connect", { key: "sk" });
  await t.call("revoke", { reason: "user" });
  expect(t.got).toEqual([]); // delivery runs from the timer, not inside the method
  await t.w.advance(0);
  expect(t.bodies()).toEqual([
    { type: "connection.active", at: 1_700_000_000_000, data: { from: null, to: "active" }, seq: 1, id: "conn:keyed:k1:1", connection: { definition: "keyed", id: "k1" } },
    { type: "connection.revoked", at: 1_700_000_000_000, data: { from: "active", to: "revoked", reason: "user" }, seq: 2, id: "conn:keyed:k1:2", connection: { definition: "keyed", id: "k1" } },
  ]);
  const first = t.got[0]!;
  expect(first.headers.get("webhook-id")).toBe("conn:keyed:k1:1");
  expect(first.headers.get("webhook-timestamp")).toBe("1700000000");
  expect(await verify(SECRET, first.headers, first.body, { now: t.w.now() })).toBe(true);
  expect(await verify(SECRET, first.headers, `${first.body} `, { now: t.w.now() })).toBe(false);
  expect(await verify(`whsec_${key(8)}`, first.headers, first.body, { now: t.w.now() })).toBe(false);
  expect(await verify(SECRET, first.headers, first.body, { now: t.w.now() + 301_000 })).toBe(false);
  // Rotation: any matching signature in the list is enough.
  const h = new Headers(first.headers);
  h.set("webhook-signature", `v1,bm9wZQ== v1,!!! ${first.headers.get("webhook-signature")}`);
  expect(await verify(SECRET, h, first.body, { now: t.w.now() })).toBe(true);

  // Relayed and delivered: the record's outbox and the queue are both empty, nothing is sent again.
  await t.call("status");
  await t.w.advance(86_400_000);
  expect(t.got.length).toBe(2);
});

test("5xx and timeouts retry with backoff; order holds across retries", async () => {
  const t = await setup();
  t.set(503);
  await t.call("connect", { key: "sk" });
  await t.w.advance(0);
  expect(t.got.length).toBe(1);
  expect(t.types()).toEqual([]);

  // A new event while parked queues behind the failing one and doesn't skip the backoff.
  await t.call("hook", { n: 1 });
  await t.w.advance(0);
  await t.w.advance(4_000); // first retry is in [5s, 10s]
  t.set(200, true); // now the endpoint hangs
  expect(t.got.length).toBe(1);
  await t.w.advance(6_000); // retry 1 times out (not recorded)
  t.set(200);
  await t.w.advance(20_000); // retry 2 in [10s, 20s] later
  expect(t.got.map((g) => JSON.parse(g.body).type)).toEqual(["connection.active", "connection.active", "webhook.push"]);
  expect(t.types()).toEqual(["connection.active", "webhook.push"]);
  expect(t.bodies()[1]).toMatchObject({ seq: 2, id: "conn:keyed:k1:2", data: { n: 1 } });
});

test("a delivery whose ack was lost is sent again with the same id", async () => {
  const t = await setup();
  t.set(500);
  await t.call("connect", { key: "sk" });
  await t.w.advance(0);
  t.set(200);
  // The server saw a 500 for attempt 1 but may have processed it; the retry carries the same id.
  await t.w.advance(10_000);
  expect(t.got.map((g) => [g.status, g.headers.get("webhook-id")])).toEqual([
    [500, "conn:keyed:k1:1"],
    [200, "conn:keyed:k1:1"],
  ]);
  expect(t.got[0]!.body).toBe(t.got[1]!.body);
  // An extra wake-up with nothing pending sends nothing.
  await t.call("status");
  await t.w.advance(60_000);
  expect(t.got.length).toBe(2);
});

test("webhook events from another extension ride the same ordered outbox", async () => {
  const t = await setup();
  await t.call("connect", { key: "sk" });
  await t.call("hook", { kind: "push" });
  await t.call("revoke");
  await t.w.advance(0);
  expect(t.bodies().map((e) => [e.seq, e.type])).toEqual([
    [1, "connection.active"],
    [2, "webhook.push"],
    [3, "connection.revoked"],
  ]);
});

test("no endpoint configured: nothing is sent and emit is a no-op", async () => {
  const t = await setup({ configured: false });
  await t.call("connect", { key: "sk" });
  await t.call("hook", { kind: "push" });
  await t.w.advance(86_400_000);
  expect(t.got).toEqual([]);
});

test("sign and verify agree on the Standard Webhooks test vector", async () => {
  // From the Standard Webhooks spec's reference tests.
  const secret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
  const id = "msg_p5jXN8AQM9LWM0D4loKWxJek";
  const body = '{"test": 2432232314}';
  const sig = await sign(secret, id, 1614265330, body);
  expect(sig).toBe("v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
  const headers = new Headers({ "webhook-id": id, "webhook-timestamp": "1614265330", "webhook-signature": sig });
  expect(await verify(secret, headers, body, { now: 1614265330_000 })).toBe(true);
});

test("a 3xx is a failed delivery: retried, never followed", async () => {
  const t = await setup();
  t.set(302);
  await t.call("connect", { key: "sk" });
  await t.w.advance(0);
  expect(t.got.map((g) => g.status)).toEqual([302]);
  t.set(200);
  await t.w.advance(10_000);
  expect(t.types()).toEqual(["connection.active"]);
});

test("a large backlog: oldest dropped past 1000, the rest delivered in order, keys freed past the KEPT newest", async () => {
  const t = await setup();
  t.set(503);
  await t.call("connect", { key: "sk" }); // seq 1
  await t.w.advance(0);
  for (let n = 0; n < 1200; n++) await t.call("hook", { n }); // seq 2..1201
  expect(t.live.size).toBe(1000 + KEPT); // the dropped ones are done: the newest KEPT of them stay
  t.set(200);
  await t.w.advance(3_600_000);
  const seqs = t.bodies().map((e) => e.seq);
  expect(seqs.length).toBe(1000);
  expect(seqs).toEqual(Array.from({ length: 1000 }, (_, i) => 202 + i));
  expect(t.bodies()[0]!.data as unknown).toEqual({ n: 200 });
  expect([...t.live].sort()).toEqual(Array.from({ length: KEPT }, (_, i) => `q:events/e/${1202 - KEPT + i}`).sort());
});

test("large payloads: each event is its own stored value, so a backlog past 2 MB still drains", async () => {
  const t = await setup();
  t.set(503);
  await t.call("connect", { key: "sk" });
  await t.w.advance(0);
  const big = "x".repeat(500_000);
  for (let n = 0; n < 20; n++) expect(await t.call("hook", { n, big })).toEqual({ ok: null }); // ~10 MB in total
  t.set(200);
  await t.w.advance(3_600_000);
  expect(t.bodies().map((e) => (e.type === "webhook.push" ? (e.data as unknown as { n: number }).n : e.type))).toEqual([
    "connection.active",
    ...Array.from({ length: 20 }, (_, i) => i),
  ]);
  // Done: bodies over BODY_KEPT aren't kept (slot 1, small, fell out of the KEPT window).
  expect([...t.live]).toEqual([]);
});

test("after() skips the outbox when no state changed: one record read, no decrypt", async () => {
  const t = await setup();
  await t.call("connect", { key: "sk" });
  await t.w.advance(0);
  t.reads.record = 0;
  await t.call("status");
  // status reads the record itself (decrypting); events only reads it once more for the seq.
  expect(t.reads.record).toBe(2);
});

test("alongside proxy() and directory(): proxied calls send nothing, state changes reach both", async () => {
  const sent: string[] = [];
  const proxied = defineConnection({ id: "keyed", auth: apiKey(["key"]), proxy: { baseUrl: "https://api.test", inject: { query: "api_key" } } });
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === URL_) sent.push((JSON.parse(init?.body as string) as ConnectionEvent).type);
    return new Response("ok");
  }) as typeof globalThis.fetch;
  const settings = {
    keys: await importKeys({ 1: key(1) }, 1),
    stateKey: await importHmacKey(key(9)),
    apiKey: "secret",
    redirectUri: "https://oc.test/callback",
    config: { keyed: null },
    events: { url: URL_, secret: SECRET },
  };
  const rt = runtime({ definitions: { keyed: proxied }, settings: async () => settings, extensions: [directory(), proxy(), events()] });
  const c = checked(rt.program);
  const w = memory(c.wrapped, { fetch });
  const send = (method: string, path: string, body?: Json) =>
    rt.fetch(new Request(`https://oc.test${path}`, { method, headers: { authorization: "Bearer secret" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), w.platform);

  expect((await send("POST", "/connections/keyed/k1/connect", { key: "sk" })).status).toBe(200);
  await w.advance(0);
  for (let n = 0; n < 3; n++) expect(await (await send("GET", "/proxy/keyed/k1/me")).text()).toBe("ok");
  await w.advance(0);
  expect(sent).toEqual(["connection.active"]);
  await send("POST", "/connections/keyed/k1/revoke");
  await w.advance(0);
  expect(sent).toEqual(["connection.active", "connection.revoked"]);
  expect((await w.platform.db.connections.list({})).connections.map((r) => [r.id, r.state])).toEqual([["k1", "revoked"]]);
  expect(c.live.size).toBe(2); // kept for the dashboard (events.status, events.redeliver)
});

test("events.status: pending, the parked head's attempt, retry time and error; recent done events", async () => {
  const t = await setup();
  const status = async () => ((await t.call("events.status")) as { ok: EventsStatus }).ok;
  expect(await status()).toEqual({ enabled: true, pending: 0, attempt: 0, retryAt: null, error: null, queued: [], recent: [] });
  t.set(500);
  await t.call("connect", { key: "sk" });
  await t.call("hook", { topic: "push", delivery: "d1", payload: { secret: "not shown" } });
  await t.w.advance(0);
  const parked = await status();
  expect(parked).toMatchObject({ pending: 2, attempt: 1, error: "HTTP 500", recent: [] });
  expect(parked.retryAt).toBeGreaterThan(t.w.now());
  const pend = { copy: false, deliveredAt: null, dropped: false, redeliverable: false };
  expect(parked.queued).toEqual([
    { slot: 1, id: "conn:keyed:k1:1", seq: 1, type: "connection.active", at: t.w.now(), data: { from: null, to: "active" }, size: expect.any(Number), ...pend },
    // Webhook payloads aren't listed: topic and delivery only.
    { slot: 2, id: "conn:keyed:k1:2", seq: 2, type: "webhook.push", at: t.w.now(), data: { topic: "push", delivery: "d1" }, size: expect.any(Number), ...pend },
  ]);
  t.set(200, true);
  await t.w.advance(parked.retryAt! - t.w.now());
  expect((await status()).error).toBe("timeout");

  // Flush: delivered now, not at the next backoff; the error clears.
  t.set(200);
  const flushed = ((await t.call("events.flush")) as { ok: EventsStatus }).ok;
  expect(flushed.retryAt).toBeNull();
  await t.w.advance(0);
  expect(t.types()).toEqual(["connection.active", "webhook.push"]);
  const done = await status();
  expect(done).toMatchObject({ pending: 0, attempt: 0, retryAt: null, error: null, queued: [] });
  expect(done.recent.map((e) => [e.slot, e.deliveredAt, e.redeliverable])).toEqual([
    [2, t.w.now(), true],
    [1, t.w.now(), true],
  ]);
});

test("events.redeliver: a done event goes out again with the same id and body, after what's queued", async () => {
  const t = await setup();
  await t.call("connect", { key: "sk" });
  await t.w.advance(0);
  const [first] = t.delivered();
  expect(await t.call("events.redeliver", { slot: 1 })).toEqual({ ok: { slot: 2 } });
  await t.w.advance(0);
  const again = t.delivered()[1]!;
  expect(again.body).toBe(first!.body);
  expect(again.headers.get("webhook-id")).toBe("conn:keyed:k1:1");
  expect(await verify(SECRET, again.headers, again.body, { now: t.w.now() })).toBe(true);
  // The copy is listed in its own slot, with the original's id.
  const s = ((await t.call("events.status")) as { ok: EventsStatus }).ok;
  expect(s.recent.map((e) => [e.slot, e.id, e.copy])).toEqual([
    [2, "conn:keyed:k1:1", true],
    [1, "conn:keyed:k1:1", false],
  ]);

  // Not yet delivered, not kept, not a slot, or events off.
  t.set(500);
  await t.call("revoke");
  expect(await t.call("events.redeliver", { slot: 3 })).toMatchObject({ error: { code: "pending", status: 409 } });
  expect(await t.call("events.redeliver", { slot: 0 })).toMatchObject({ error: { code: "not_found", status: 404 } });
  expect(await t.call("events.redeliver", { slot: "1" })).toMatchObject({ error: { code: "bad_request" } });
  const off = await setup({ configured: false });
  expect(await off.call("events.redeliver", { slot: 1 })).toMatchObject({ error: { code: "not_configured", status: 503 } });
  expect(await off.call("events.flush")).toMatchObject({ error: { code: "not_configured" } });
  expect(await off.call("events.status")).toMatchObject({ ok: { enabled: false, pending: 0 } });
});

test("only the KEPT newest done events stay redeliverable", async () => {
  const t = await setup();
  await t.call("connect", { key: "sk" });
  for (let n = 0; n < KEPT + 5; n++) await t.call("hook", { n });
  await t.w.advance(0);
  const s = ((await t.call("events.status")) as { ok: EventsStatus }).ok;
  expect(s.recent.length).toBe(KEPT);
  expect(s.recent[0]!.slot).toBe(KEPT + 6);
  expect(t.live.size).toBe(KEPT);
  expect(await t.call("events.redeliver", { slot: 6 })).toMatchObject({ error: { code: "not_found" } });
  expect(await t.call("events.redeliver", { slot: 7 })).toEqual({ ok: { slot: KEPT + 7 } });
});

test("a redelivered copy takes no seq: real events stay gapless, ids unique; the copy arrives after newer ones", async () => {
  const t = await setup();
  await t.call("connect", { key: "sk" }); // seq 1
  for (let n = 0; n < 4; n++) await t.call("hook", { n }); // seq 2..5
  await t.w.advance(0);
  expect(await t.call("events.redeliver", { slot: 3 })).toEqual({ ok: { slot: 6 } });
  await t.call("hook", { n: 4 }); // the next real event: seq 6, in slot 7
  await t.call("revoke"); // seq 7
  await t.w.advance(0);
  const got = t.bodies();
  expect(got.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 3, 6, 7]);
  expect(got.map((e) => e.id)).toEqual([1, 2, 3, 4, 5, 3, 6, 7].map((n) => `conn:keyed:k1:${n}`));
  // The copy is the same body; every real event has its own id.
  expect(t.delivered()[5]!.body).toBe(t.delivered()[2]!.body);
  const real = got.filter((_, i) => i !== 5);
  expect(new Set(real.map((e) => e.id)).size).toBe(real.length);
  expect(real.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
});

test("retention is bounded by bytes: big bodies aren't kept once done (payload_not_retained), status reads no body", async () => {
  const t = await setup();
  await t.call("connect", { key: "sk" });
  await t.call("hook", { big: "x".repeat(BODY_KEPT) }); // just over the cap with its envelope
  await t.call("hook", { small: 1 });
  await t.w.advance(0);
  expect([...t.live].sort()).toEqual(["q:events/e/1", "q:events/e/3"]);
  t.reads.bodies = 0;
  const s = ((await t.call("events.status")) as { ok: EventsStatus }).ok;
  expect(t.reads.bodies).toBe(0);
  expect(s.recent.map((e) => [e.slot, e.redeliverable, e.size > BODY_KEPT])).toEqual([
    [3, true, false],
    [2, false, true],
    [1, true, false],
  ]);
  expect(await t.call("events.redeliver", { slot: 2 })).toMatchObject({ error: { code: "payload_not_retained", status: 410 } });
  expect(await t.call("events.redeliver", { slot: 3 })).toEqual({ ok: { slot: 4 } });
});
