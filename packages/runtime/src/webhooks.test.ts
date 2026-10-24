import { expect, test } from "bun:test";
import { apiKey, defineConnection, hmacHex, type StandardSchemaV1, safeEqual } from "@openconnect/connections";
import { importHmacKey, importKeys, type Json } from "@openconnect/kernel";
import { memory } from "@openconnect/kernel/memory";
import { type ConnectionEvent, directory, events, MAX_PAYLOAD, memoryIndex, runtime, type WebhookEvent, webhooks } from "./index.ts";

const key = (n: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(n)));
const T0 = 1_700_000_000_000;

// The provider fake: what register/unregister were asked, and knobs for failures and channel lifetime.
const fake = {
  fail: 0,
  ttl: null as number | null,
  n: 0,
  registered: [] as { url: string; secret: string; key: string }[],
  unregistered: [] as Json[],
  /** Runs inside register, before it returns (to race it). */
  during: null as (() => Promise<unknown>) | null,
  externalThrows: false,
};

/**
 * A test provider: `x-sig` = hex HMAC of the body under the connection's secret (per-connection
 * route) or the app secret (app route). `{ type: "hello" }` is a handshake; `team` routes app-level.
 */
const hooked = defineConnection({
  id: "hooked",
  auth: apiKey<{ appSecret: string }>(["key", "team"]),
  metadata: async (_ctx, cred) => ({ team: cred.kind === "static" ? (cred.fields.team ?? "") : "" }),
  external: (m) => {
    if (fake.externalThrows) throw new Error("external blew up");
    return { team: m.team };
  },
  webhooks: {
    verify: async (ctx, req, secret) => safeEqual(req.headers.get("x-sig") ?? "", await hmacHex(secret ?? ctx.config.appSecret, req.body)),
    parse(req) {
      const b = JSON.parse(req.body) as { type: string; id?: string; team?: string };
      if (b.type === "hello") return { reply: { hi: true } };
      return { topic: b.type, payload: b as unknown as Json, ...(b.id ? { delivery: b.id } : {}), ...(b.team ? { external: { key: "team", value: b.team } } : {}) };
    },
    async register(ctx, cred, endpoint) {
      if (fake.fail > 0) {
        fake.fail--;
        throw new Error("provider down");
      }
      await fake.during?.();
      fake.registered.push({ ...endpoint, key: cred.kind === "static" ? (cred.fields.key ?? "") : "" });
      const id = `h${++fake.n}`;
      return { hook: id, ...(fake.ttl ? { expiresAt: ctx.now() + fake.ttl } : {}) };
    },
    async unregister(_ctx, _cred, hook) {
      fake.unregistered.push(hook);
    },
  },
});
const plain = defineConnection({ id: "plain", auth: apiKey(["key"]) });

/** `{ repo: string }`, as a Standard Schema. */
const repoSchema: StandardSchemaV1<{ repo: string }> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (v) =>
      typeof (v as { repo?: unknown } | null)?.repo === "string" ? { value: { repo: (v as { repo: string }).repo } } : { issues: [{ message: "Expected string", path: ["repo"] }] },
  },
};
const subs = { registered: [] as { repo: string; key: string; url: string }[], unregistered: [] as Json[], ttl: null as number | null };
/** Like `hooked`, with explicit subscriptions: one hook per repo. */
const subbed = defineConnection({
  ...hooked,
  id: "subbed",
  webhooks: {
    ...hooked.webhooks!,
    subscription: repoSchema,
    async register(ctx, cred, endpoint, input: { repo: string }) {
      const key = cred.kind === "static" ? (cred.fields.key ?? "") : "";
      subs.registered.push({ repo: input.repo, key, url: endpoint.url });
      return { hook: `${input.repo}#${subs.registered.length}`, ...(subs.ttl ? { expiresAt: ctx.now() + subs.ttl } : {}) };
    },
    async unregister(_ctx, _cred, hook) {
      subs.unregistered.push(hook);
    },
  },
});

async function setup(o: { events?: boolean; down?: string } = {}) {
  Object.assign(fake, { fail: 0, ttl: null, n: 0, registered: [], unregistered: [], during: null, externalThrows: false });
  Object.assign(subs, { registered: [], unregistered: [], ttl: null });
  const got: ConnectionEvent[] = [];
  const settings = {
    keys: await importKeys({ 1: key(1) }, 1),
    stateKey: await importHmacKey(key(9)),
    apiKey: "secret",
    redirectUri: "https://oc.test/callback",
    config: { hooked: { appSecret: "app" }, subbed: { appSecret: "app" }, plain: null },
    fetch: (async (_url: string, init?: RequestInit) => (got.push(JSON.parse(init?.body as string)), new Response(null, { status: 200 }))) as typeof fetch,
    webhooks: { url: "https://oc.test/webhooks/", key: await importHmacKey(key(5)) },
    ...(o.events === false ? {} : { events: { url: "https://app.test/events", secret: `whsec_${key(7)}` } }),
  };
  let w: ReturnType<typeof memory> | undefined;
  const rt = runtime({
    definitions: { hooked, subbed, plain },
    settings: async () => settings,
    extensions: [events(), directory(memoryIndex()), webhooks()],
    now: () => w!.now(),
  });
  w = memory(rt.program, { now: T0 });
  const send = async (method: string, path: string, body: string, headers: Record<string, string> = {}) => {
    // `down`: that instance's DO throws on receive (a fan-out failure).
    const call = (i: string, m: string, a: Json) => (i === o.down && m === "webhooks.receive" ? Promise.reject(new Error("DO down")) : w!.call(i, m, a));
    const res = await rt.fetch(new Request(`https://oc.test${path}`, { method, headers, body }), call);
    return { status: res.status, body: (await res.json()) as any };
  };
  const api = (path: string, body: Json = null) => send("POST", path, JSON.stringify(body), { authorization: "Bearer secret" });
  /** A provider POST signed with `secret`. */
  const hook = async (path: string, payload: Json, secret: string) => {
    const body = JSON.stringify(payload);
    return send("POST", path, body, { "x-sig": await hmacHex(secret, body) });
  };
  const secretOf = async (id: string) => (await api(`/connections/hooked/${id}/webhooks.endpoint`)).body as { url: string; secret: string };
  const webhooksOf = async (id?: string) => {
    await w!.advance(0); // events go out from the timer
    return got.filter((e): e is WebhookEvent => e.type === "webhook" && (!id || e.connection.id === id));
  };
  return { w: w!, api, hook, send, got, secretOf, webhooksOf };
}

test("per-connection: verified with the connection's own secret, delivered after the lifecycle events", async () => {
  const t = await setup();
  await t.api("/connections/hooked/c1/connect", { key: "k", team: "T1" });
  const ep = await t.secretOf("c1");
  expect(ep.url).toBe("https://oc.test/webhooks/hooked/c1");
  expect(ep.secret).not.toBe((await t.secretOf("c2")).secret); // one secret per connection

  expect(await t.hook("/webhooks/hooked/c1", { type: "push", id: "d1", n: 1 }, ep.secret)).toEqual({ status: 200, body: { delivered: 1 } });
  await t.w.advance(0);
  expect(t.got.map((e) => e.type)).toEqual(["connection.active", "webhook"]);
  expect(t.got[1]).toMatchObject({ connection: { definition: "hooked", id: "c1" }, data: { topic: "push", delivery: "d1", payload: { type: "push", id: "d1", n: 1 } } });

  // Wrong secret, another connection's secret, the app secret, tampered body: all 401, nothing delivered.
  expect((await t.hook("/webhooks/hooked/c1", { type: "push" }, "nope")).status).toBe(401);
  expect((await t.hook("/webhooks/hooked/c1", { type: "push" }, (await t.secretOf("c2")).secret)).status).toBe(401);
  expect((await t.send("POST", "/webhooks/hooked/c1", `{"type":"push"}`, { "x-sig": await hmacHex(ep.secret, `{"type":"pull"}`) })).status).toBe(401);
  // Handshakes are answered, not delivered.
  expect(await t.hook("/webhooks/hooked/c1", { type: "hello" }, ep.secret)).toEqual({ status: 200, body: { hi: true } });
  expect((await t.webhooksOf()).length).toBe(1);

  // No such connection, revoked, unparseable, wrong method, unknown definition / no webhooks.
  expect((await t.hook("/webhooks/hooked/nobody", { type: "push" }, (await t.secretOf("nobody")).secret)).status).toBe(404);
  expect((await t.send("POST", "/webhooks/hooked/c1", "nope", { "x-sig": await hmacHex(ep.secret, "nope") })).status).toBe(400);
  expect((await t.send("GET", "/webhooks/hooked/c1", "")).status).toBe(405);
  expect((await t.send("POST", "/webhooks/plain/p1", "{}")).status).toBe(404);
  expect((await t.send("POST", "/webhooks/github/p1", "{}")).status).toBe(404);
  await t.api("/connections/hooked/c1/revoke");
  expect((await t.hook("/webhooks/hooked/c1", { type: "push" }, ep.secret)).body.error.code).toBe("gone");
});

test("per-connection: a payload naming another account is refused (no cross-tenant replay of app-signed webhooks)", async () => {
  const t = await setup();
  await t.api("/connections/hooked/c1/connect", { key: "k", team: "T1" });
  const s = (await t.secretOf("c1")).secret;
  expect((await t.hook("/webhooks/hooked/c1", { type: "msg", team: "T2" }, s)).status).toBe(403);
  expect((await t.hook("/webhooks/hooked/c1", { type: "msg", team: "T1" }, s)).status).toBe(200);
});

test("app-level: routed by external id, fanned out to every live connection of that account", async () => {
  const t = await setup();
  for (const [id, team] of [["a1", "T1"], ["a2", "T1"], ["b1", "T2"], ["a3", "T1"]] as const) await t.api(`/connections/hooked/${id}/connect`, { key: "k", team });
  await t.api("/connections/hooked/a3/revoke");

  expect(await t.hook("/webhooks/hooked", { type: "msg", team: "T1", id: "Ev1" }, "app")).toEqual({ status: 200, body: { delivered: 2 } });
  const got = await t.webhooksOf();
  expect(got.map((e) => e.connection.id).sort()).toEqual(["a1", "a2"]);
  expect(got.every((e) => e.data.delivery === "Ev1")).toBe(true);

  expect(await t.hook("/webhooks/hooked", { type: "msg", team: "T9" }, "app")).toEqual({ status: 200, body: { delivered: 0 } });
  expect((await t.hook("/webhooks/hooked", { type: "msg" }, "app")).status).toBe(400); // nothing to route by
  expect((await t.hook("/webhooks/hooked", { type: "msg", team: "T1" }, "wrong")).status).toBe(401);
  expect(await t.hook("/webhooks/hooked", { type: "hello" }, "app")).toEqual({ status: 200, body: { hi: true } });
  // Receive is the route's alone: an API key can't inject a webhook.
  expect((await t.api("/connections/hooked/a1/webhooks.receive", { data: { topic: "x", delivery: null, payload: null } })).status).toBe(404);
});

test("payloads past MAX_PAYLOAD are delivered without the payload, with its size", async () => {
  const t = await setup();
  await t.api("/connections/hooked/c1/connect", { key: "k", team: "T1" });
  const big = { type: "push", blob: "x".repeat(MAX_PAYLOAD) };
  expect((await t.hook("/webhooks/hooked/c1", big, (await t.secretOf("c1")).secret)).status).toBe(200);
  const [e] = await t.webhooksOf();
  expect(e!.data).toEqual({ topic: "push", delivery: null, payload: null, truncated: JSON.stringify(big).length });
});

test("without settings.events, an event is refused (503) rather than dropped; handshakes still work", async () => {
  const t = await setup({ events: false });
  await t.api("/connections/hooked/c1/connect", { key: "k", team: "T1" });
  const s = (await t.secretOf("c1")).secret;
  expect((await t.hook("/webhooks/hooked/c1", { type: "push" }, s)).status).toBe(503);
  expect((await t.hook("/webhooks/hooked/c1", { type: "hello" }, s)).status).toBe(200);
});

test("auto-registration: once when active, retried with backoff, renewed before expiry, removed before revoke", async () => {
  const t = await setup();
  fake.fail = 2;
  await t.api("/connections/hooked/c1/connect", { key: "k", team: "T1" });
  expect(fake.registered).toEqual([]); // runs from the timer
  await t.w.advance(0); // attempt 1 fails
  await t.w.advance(30_000); // attempt 2 (in [15s, 30s]) fails
  expect(fake.registered).toEqual([]);
  await t.w.advance(60_000); // attempt 3 succeeds
  const ep = await t.secretOf("c1");
  expect(fake.registered).toEqual([{ ...ep, key: "k" }]);

  // Idempotent: more calls and timers register nothing new.
  await t.api("/connections/hooked/c1/token");
  await t.w.advance(86_400_000);
  expect(fake.registered.length).toBe(1);

  await t.api("/connections/hooked/c1/revoke");
  expect(fake.unregistered).toEqual(["h1"]);
  await t.w.advance(86_400_000);
  expect(fake.registered.length).toBe(1);
});

test("auto-registration: lapsing subscriptions are renewed an hour before expiry, the old one stopped", async () => {
  const t = await setup();
  fake.ttl = 7 * 86_400_000;
  await t.api("/connections/hooked/c1/connect", { key: "k", team: "T1" });
  await t.w.advance(0);
  expect(fake.n).toBe(1);
  await t.w.advance(fake.ttl - 3_600_001);
  expect(fake.n).toBe(1);
  await t.w.advance(1);
  expect(fake.n).toBe(2);
  expect(fake.unregistered).toEqual(["h1"]);
  await t.w.advance(fake.ttl - 3_600_000);
  expect(fake.n).toBe(3);
  expect(fake.unregistered).toEqual(["h1", "h2"]);
  await t.api("/connections/hooked/c1/revoke");
  expect(fake.unregistered).toEqual(["h1", "h2", "h3"]);
});

test("auto-registration: after giving up, the next change to the connection tries again", async () => {
  const t = await setup();
  fake.fail = 100;
  await t.api("/connections/hooked/c1/connect", { key: "k", team: "T1" });
  for (let i = 0; i < 10; i++) await t.w.advance(3_600_000); // gives up after 8 attempts
  const tries = 100 - fake.fail;
  expect(tries).toBe(8);
  fake.fail = 0;
  await t.w.advance(86_400_000);
  await t.api("/connections/hooked/c1/status"); // no change, no retry
  await t.w.advance(0);
  expect(fake.registered).toEqual([]);
  await t.api("/connections/hooked/c1/connect", { key: "k2", team: "T1" }); // re-auth
  await t.w.advance(0);
  expect(fake.registered.map((r) => r.key)).toEqual(["k2"]);
});

test("auto-registration: a renewal that gave up is retried on the next change to the connection", async () => {
  const t = await setup();
  fake.ttl = 7 * 86_400_000;
  await t.api("/connections/hooked/c1/connect", { key: "k", team: "T1" });
  await t.w.advance(0);
  expect(fake.n).toBe(1);
  fake.fail = 100;
  await t.w.advance(fake.ttl - 3_600_000); // renewal is due
  for (let i = 0; i < 10; i++) await t.w.advance(3_600_000); // fails 8 times, gives up; the hook lapses
  expect(100 - fake.fail).toBe(8);
  fake.fail = 0;
  await t.api("/connections/hooked/c1/connect", { key: "k", team: "T1" }); // re-auth
  await t.w.advance(0);
  expect(fake.n).toBe(2);
  expect(fake.unregistered).toEqual(["h1"]);
});

test("auto-registration: state changes don't reset a registration that's backing off", async () => {
  const t = await setup();
  fake.fail = 1;
  await t.api("/connections/hooked/c1/connect", { key: "k", team: "T1" });
  await t.w.advance(0); // attempt 1 fails; retry in [15s, 30s]
  await t.api("/connections/hooked/c1/connect", { key: "k", team: "T1" }); // version moves
  await t.w.advance(0);
  expect(fake.registered).toEqual([]); // the backoff held
  await t.w.advance(30_000);
  expect(fake.registered.length).toBe(1);
});

test("auto-registration: a re-auth to another account re-registers and stops the old hook", async () => {
  const t = await setup();
  await t.api("/connections/hooked/c1/connect", { key: "k", team: "T1" });
  await t.w.advance(0);
  await t.api("/connections/hooked/c1/connect", { key: "k", team: "T1" }); // same account: nothing
  await t.w.advance(0);
  expect(fake.n).toBe(1);
  await t.api("/connections/hooked/c1/connect", { key: "k2", team: "T2" });
  await t.w.advance(0);
  expect(fake.registered.map((r) => r.key)).toEqual(["k", "k2"]);
  expect(fake.unregistered).toEqual(["h1"]);
});

test("auto-registration: a revoke landing mid-registration undoes it", async () => {
  const t = await setup();
  fake.during = () => t.api("/connections/hooked/c1/revoke");
  await t.api("/connections/hooked/c1/connect", { key: "k", team: "T1" });
  await t.w.advance(0);
  expect(fake.registered.length).toBe(1);
  expect(fake.unregistered).toEqual(["h1"]); // beforeRevoke found nothing; sync removed it
  fake.during = null;
  await t.w.advance(86_400_000);
  expect(fake.registered.length).toBe(1);
});

test("app-level: a connection that fails to take it makes the route 503, so the provider retries", async () => {
  const t = await setup({ down: "conn:hooked:a2" });
  for (const id of ["a1", "a2"]) await t.api(`/connections/hooked/${id}/connect`, { key: "k", team: "T1" });
  const r = await t.hook("/webhooks/hooked", { type: "msg", team: "T1", id: "Ev1" }, "app");
  expect(r.status).toBe(503);
  expect(r.body.error).toMatchObject({ code: "delivery_failed", message: "1 of 2 connections did not take the webhook" });
  // a1 took it; the provider's retry delivers it again with the same `delivery`.
  expect((await t.webhooksOf()).map((e) => [e.connection.id, e.data.delivery])).toEqual([["a1", "Ev1"]]);
});

test("auto-registration: a short-lived or already lapsed expiry renews after a floor, not in a loop", async () => {
  const t = await setup();
  fake.ttl = -1; // the provider says it has already expired
  await t.api("/connections/hooked/c1/connect", { key: "k", team: "T1" });
  await t.w.advance(0);
  await t.api("/connections/hooked/c1/status");
  await t.w.advance(59_999);
  expect(fake.n).toBe(1);
  await t.w.advance(1);
  expect(fake.n).toBe(2);
  fake.ttl = 10 * 60_000; // 10 min: renewed at half its life
  await t.w.advance(60_000);
  expect(fake.n).toBe(3);
  await t.w.advance(5 * 60_000 - 1);
  expect(fake.n).toBe(3);
  await t.w.advance(1);
  expect(fake.n).toBe(4);
});

test("auto-registration: an external hook that throws is an unknown account, not a new one", async () => {
  const t = await setup();
  await t.api("/connections/hooked/c1/connect", { key: "k", team: "T1" });
  await t.w.advance(0);
  fake.externalThrows = true;
  await t.api("/connections/hooked/c1/connect", { key: "k", team: "T1" }); // version moves
  await t.w.advance(0);
  expect(fake.n).toBe(1);
  expect(fake.unregistered).toEqual([]);
});

test("webhooks.status: the registration and the ingress URL, never the secret", async () => {
  const t = await setup();
  fake.ttl = 7 * 86_400_000;
  await t.api("/connections/hooked/c1/connect", { key: "k", team: "T1" });
  const armed = (await t.api("/connections/hooked/c1/webhooks.status")).body;
  expect(armed).toEqual({ supported: true, registers: true, url: "https://oc.test/webhooks/hooked/c1", registration: null, pending: true, subscriptions: null });
  await t.w.advance(0);
  const s = (await t.api("/connections/hooked/c1/webhooks.status")).body;
  expect(s).toEqual({
    supported: true,
    registers: true,
    url: "https://oc.test/webhooks/hooked/c1",
    registration: { hook: "h1", renewAt: T0 + fake.ttl - 3_600_000, account: JSON.stringify({ team: "T1" }) },
    pending: false,
    subscriptions: null,
  });
  expect(JSON.stringify(s)).not.toContain((await t.secretOf("c1")).secret);
  expect((await t.api("/connections/plain/p1/webhooks.status")).body).toEqual({ supported: false, registers: false, url: null, registration: null, pending: false, subscriptions: null });
});

test("subscriptions: many per connection, input checked, renewed, moved on re-auth to another account, all removed on revoke", async () => {
  const t = await setup();
  const base = "/connections/subbed/c1";
  expect((await t.api(`${base}/webhooks.subscribe`, { repo: "o/a" })).body.error).toMatchObject({ code: "not_active", status: 409 });
  await t.api(`${base}/connect`, { key: "k", team: "T1" });
  await t.w.advance(0);
  expect(subs.registered).toEqual([]); // nothing on its own

  const bad = await t.api(`${base}/webhooks.subscribe`, { repo: 1 });
  expect(bad.status).toBe(400);
  expect(bad.body.error).toMatchObject({ code: "bad_request", issues: [{ message: "Expected string", path: ["repo"] }] });

  subs.ttl = 86_400_000;
  const a = (await t.api(`${base}/webhooks.subscribe`, { repo: "o/a" })).body;
  subs.ttl = null;
  const b = (await t.api(`${base}/webhooks.subscribe`, { repo: "o/b" })).body;
  expect(a).toMatchObject({ input: { repo: "o/a" }, hook: "o/a#1", account: '{"team":"T1"}', renewAt: T0 + 86_400_000 - 3_600_000 });
  expect(b).toMatchObject({ input: { repo: "o/b" }, hook: "o/b#2", renewAt: null });
  expect(subs.registered.map((r) => r.url)).toEqual(["https://oc.test/webhooks/subbed/c1", "https://oc.test/webhooks/subbed/c1"]);
  expect(((await t.api(`${base}/webhooks.list`)).body as { id: string }[]).map((s) => s.id).sort()).toEqual([a.id, b.id].sort());
  expect((await t.api(`${base}/webhooks.status`)).body).toMatchObject({ registers: false, subscriptions: 2 });

  // Webhooks arrive on the connection's route, as before.
  expect((await t.hook("/webhooks/subbed/c1", { type: "push", id: "d1" }, (await t.api(`${base}/webhooks.endpoint`)).body.secret)).status).toBe(200);

  // Only the lapsing one is renewed: new hook first, then the old one stopped.
  await t.w.advance(86_400_000 - 3_600_000);
  expect(subs.registered.map((r) => r.repo)).toEqual(["o/a", "o/b", "o/a"]);
  expect(subs.unregistered).toEqual(["o/a#1"]);

  // Unsubscribe: gone here and at the provider; twice is a 404.
  expect((await t.api(`${base}/webhooks.unsubscribe`, { id: b.id })).status).toBe(200);
  expect(subs.unregistered).toEqual(["o/a#1", "o/b#2"]);
  expect((await t.api(`${base}/webhooks.unsubscribe`, { id: b.id })).status).toBe(404);

  // Re-auth to another workspace: re-registered with the new credential, the old hook stopped.
  await t.api(`${base}/connect`, { key: "k2", team: "T2" });
  await t.w.advance(0);
  expect(subs.registered.at(-1)).toMatchObject({ repo: "o/a", key: "k2" });
  expect(subs.unregistered).toEqual(["o/a#1", "o/b#2", "o/a#3"]);
  expect((await t.api(`${base}/webhooks.list`)).body).toMatchObject([{ id: a.id, account: '{"team":"T2"}' }]);

  // Revoke removes the rest.
  await t.api(`${base}/revoke`);
  expect(subs.unregistered).toEqual(["o/a#1", "o/b#2", "o/a#3", "o/a#4"]);
  expect((await t.api(`${base}/webhooks.list`)).body).toEqual([]);

  // A definition without a subscription schema takes none.
  await t.api("/connections/hooked/c1/connect", { key: "k", team: "T1" });
  expect((await t.api("/connections/hooked/c1/webhooks.subscribe", { repo: "o/a" })).status).toBe(400);
});
