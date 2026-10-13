import { expect, test } from "bun:test";
import { apiKey, defineConnection, hmacHex, safeEqual } from "@openconnect/connections";
import { importHmacKey, importKeys, type Json } from "@openconnect/kernel";
import { memory } from "@openconnect/kernel/memory";
import { type ConnectionEvent, directory, events, MAX_PAYLOAD, memoryIndex, runtime, type WebhookEvent, webhooks } from "./index.ts";

const key = (n: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(n)));
const T0 = 1_700_000_000_000;

// The provider fake: what register/unregister were asked, and knobs for failures and channel lifetime.
const fake = { fail: 0, ttl: null as number | null, n: 0, registered: [] as { url: string; secret: string; key: string }[], unregistered: [] as Json[] };

/**
 * A test provider: `x-sig` = hex HMAC of the body under the connection's secret (per-connection
 * route) or the app secret (app route). `{ type: "hello" }` is a handshake; `team` routes app-level.
 */
const hooked = defineConnection({
  id: "hooked",
  auth: apiKey<{ appSecret: string }>(["key", "team"]),
  metadata: async (_ctx, cred) => ({ team: cred.kind === "static" ? (cred.fields.team ?? "") : "" }),
  external: (m) => ({ team: m.team }),
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

async function setup(o: { events?: boolean } = {}) {
  Object.assign(fake, { fail: 0, ttl: null, n: 0, registered: [], unregistered: [] });
  const got: ConnectionEvent[] = [];
  const settings = {
    keys: await importKeys({ 1: key(1) }, 1),
    stateKey: await importHmacKey(key(9)),
    apiKey: "secret",
    redirectUri: "https://oc.test/callback",
    config: { hooked: { appSecret: "app" }, plain: null },
    fetch: (async (_url: string, init?: RequestInit) => (got.push(JSON.parse(init?.body as string)), new Response(null, { status: 200 }))) as typeof fetch,
    webhooks: { url: "https://oc.test/webhooks/", key: await importHmacKey(key(5)) },
    ...(o.events === false ? {} : { events: { url: "https://app.test/events", secret: `whsec_${key(7)}` } }),
  };
  let w: ReturnType<typeof memory> | undefined;
  const rt = runtime({
    definitions: { hooked, plain },
    settings: async () => settings,
    extensions: [events(), directory(memoryIndex()), webhooks()],
    now: () => w!.now(),
  });
  w = memory(rt.program, { now: T0 });
  const send = async (method: string, path: string, body: string, headers: Record<string, string> = {}) => {
    const res = await rt.fetch(new Request(`https://oc.test${path}`, { method, headers, body }), w!.call);
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
