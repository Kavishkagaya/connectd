import { expect, test } from "bun:test";
import { apiKey as apiKeyAuth, defineConnection } from "@kavishkagaya/connectd-connections";
import { importHmacKey, importKeys, type Json } from "@kavishkagaya/connectd-kernel";
import { memory } from "@kavishkagaya/connectd-kernel/memory";
import { ADMIN_TTL_MS, apiKey, eventSecrets, KEY_CACHE_MS, newSession, readToken, ROOT_SESSION_MS, session, sessionCookie, token } from "./access.ts";
import { events } from "./events.ts";
import { runtime } from "./runtime.ts";
import { verify } from "./signature.ts";

const key = (n: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(n)));
const keyed = defineConnection({ id: "keyed", auth: apiKeyAuth(["key"]) });
const T0 = 1_700_000_000_000;

async function setup() {
  const sent: { headers: Headers; body: string }[] = [];
  const fetch = (async (_u: string, init?: RequestInit) => (sent.push({ headers: new Headers(init?.headers), body: init?.body as string }), new Response("ok"))) as typeof globalThis.fetch;
  const settings = {
    keys: await importKeys({ 1: key(1) }, 1),
    stateKey: await importHmacKey(key(9)),
    admin: await importHmacKey(key(8)),
    redirectUri: "https://oc.test/callback",
    config: { keyed: null },
    events: { url: "https://app.test/events" },
  };
  const rt = runtime({ definitions: { keyed }, settings: async () => settings, extensions: [events()] });
  const w = memory(rt.program, { fetch, now: T0 });
  const send = (path: string, init: RequestInit = {}) => rt.fetch(new Request(`https://oc.test${path}`, init), w.platform);
  const json = async (r: Response) => ({ status: r.status, body: (await r.json()) as any });
  /** A CLI request: a fresh admin token each time. */
  const admin = async (path: string, body?: Json) =>
    json(
      await send(path, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Admin ${await token(settings.admin, "admin", w.now(), ADMIN_TTL_MS)}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const as = (k: string, path = "/connections/keyed/k1") => send(path, { headers: { authorization: `Bearer ${k}` } });
  return { settings, w, send, json, admin, as, sent };
}

test("admin: create an API key, use it, list it without its secret; nothing else gets in", async () => {
  const t = await setup();
  expect((await t.json(await t.send("/admin/keys"))).status).toBe(401);
  const made = await t.admin("/admin/keys", { name: "web" });
  expect(made.status).toBe(201);
  expect(made.body.key).toMatch(/^ock_[0-9a-f]{12}_[\w-]{43}$/);
  expect(made.body.info).toMatchObject({ kind: "api", name: "web", status: "active", prefix: made.body.key.slice(0, 16), revokedAt: null });
  expect(made.body.info.value).toBeUndefined();

  expect((await t.as(made.body.key)).status).toBe(404); // in: no such connection yet
  expect((await t.as(`${made.body.key}x`)).status).toBe(401);
  expect((await t.as("secret")).status).toBe(401);
  const list = await t.admin("/admin/keys");
  expect(list.body.map((k: any) => k.name)).toEqual(["web"]);
  expect(JSON.stringify(list.body)).not.toContain(made.body.key.slice(17));
  // An API key never manages keys.
  expect((await t.json(await t.as(made.body.key, "/admin/keys"))).status).toBe(401);
  expect((await t.admin("/admin/keys", { name: "" })).status).toBe(400);
  expect((await t.admin("/admin/keys", { name: "x", kind: "root" })).status).toBe(400);
  expect((await t.admin("/admin/info")).body).toMatchObject({ url: "https://oc.test", keys: { api: 1, events: 0 }, accounts: 0, events: true });
});

test("admin tokens: used once, expire, can't claim a long life, and only under the admin key", async () => {
  const t = await setup();
  const tok = await token(t.settings.admin, "admin", t.w.now(), ADMIN_TTL_MS);
  const get = (s: string) => t.send("/admin/keys", { headers: { authorization: `Admin ${s}` } });
  expect((await get(tok)).status).toBe(200);
  expect((await get(tok)).status).toBe(401); // replayed
  expect((await get(await token(t.settings.admin, "admin", t.w.now(), ADMIN_TTL_MS + 1000))).status).toBe(401);
  expect((await get(await token(t.settings.admin, "login", t.w.now(), ADMIN_TTL_MS))).status).toBe(401);
  expect((await get(await token(await importHmacKey(key(2)), "admin", t.w.now(), ADMIN_TTL_MS))).status).toBe(401);
  const late = await token(t.settings.admin, "admin", t.w.now(), ADMIN_TTL_MS);
  await t.w.advance(ADMIN_TTL_MS);
  expect((await get(late)).status).toBe(401);
});

test("roll: the old secret works through the grace period, then only the new one; revoke ends both", async () => {
  const t = await setup();
  const { key: k1, info } = (await t.admin("/admin/keys", { name: "web" })).body;
  const rolled = await t.admin(`/admin/keys/${info.id}/roll`, { graceMs: 3_600_000 });
  expect(rolled.body.info).toMatchObject({ id: info.id, status: "rolling", previousUntil: T0 + 3_600_000 });
  const k2 = rolled.body.key;
  expect(k2.slice(0, 16)).toBe(k1.slice(0, 16));
  expect((await t.as(k1)).status).toBe(404);
  expect((await t.as(k2)).status).toBe(404);
  await t.w.advance(3_600_000);
  expect((await t.as(k1)).status).toBe(401);
  expect((await t.as(k2)).status).toBe(404);

  // No grace: the old one stops at once.
  const k3 = (await t.admin(`/admin/keys/${info.id}/roll`, {})).body.key;
  expect((await t.as(k2)).status).toBe(401);
  expect((await t.as(k3)).status).toBe(404);
  expect((await t.admin(`/admin/keys/${info.id}/roll`, { graceMs: -1 })).status).toBe(400);

  expect((await t.admin(`/admin/keys/${info.id}/revoke`, {})).body.status).toBe("revoked");
  expect((await t.as(k3)).status).toBe(401);
  expect((await t.admin(`/admin/keys/${info.id}/revoke`, {})).status).toBe(404);
  expect((await t.admin(`/admin/keys/${info.id}/roll`, {})).status).toBe(404);
});

test("an isolate trusts a cached key for KEY_CACHE_MS; a revoke elsewhere lands after that", async () => {
  const t = await setup();
  const { key: k, info } = (await t.admin("/admin/keys", { name: "web" })).body;
  expect((await t.as(k)).status).toBe(404);
  // Another isolate revokes it, straight in the database.
  await t.w.platform.db.keys.revoke(info.id, t.w.now());
  expect((await t.as(k)).status).toBe(404);
  await t.w.advance(KEY_CACHE_MS);
  expect((await t.as(k)).status).toBe(401);
});

test("lastUsedAt: written on use, at most once a minute", async () => {
  const t = await setup();
  const { key: k, info } = (await t.admin("/admin/keys", { name: "web" })).body;
  const req = new Request("https://oc.test/x", { headers: { authorization: `Bearer ${k}` } });
  await apiKey(t.w.platform, req);
  await t.w.settle();
  expect((await t.w.platform.db.keys.get(info.id))?.lastUsedAt).toBe(T0);
  await t.w.advance(30_000);
  await apiKey(t.w.platform, req);
  await t.w.settle();
  expect((await t.w.platform.db.keys.get(info.id))?.lastUsedAt).toBe(T0);
});

test("events secrets: none yet parks delivery; then signed with every live one, a rolled one's old secret through its grace", async () => {
  const t = await setup();
  await t.json(await t.send("/connections/keyed/k1/connect", { method: "POST", headers: { authorization: `Bearer ${(await t.admin("/admin/keys", { name: "app" })).body.key}` }, body: JSON.stringify({ key: "x" }) }));
  await t.w.advance(1000);
  expect(t.sent).toEqual([]);

  const { key: s1, info } = (await t.admin("/admin/keys", { name: "events", kind: "events" })).body;
  expect(s1).toMatch(/^whsec_/);
  expect((await t.w.platform.db.keys.get(info.id))?.value).not.toContain(s1.slice(6, 20)); // sealed
  await t.w.call("conn:keyed:k1", "events.flush", null);
  await t.w.advance(KEY_CACHE_MS);
  await t.w.call("conn:keyed:k1", "events.flush", null);
  await t.w.advance(1);
  const first = t.sent.at(-1)!;
  expect(await verify(s1, first.headers, first.body, { now: t.w.now() })).toBe(true);

  const s2 = (await t.admin(`/admin/keys/${info.id}/roll`, { graceMs: 86_400_000 })).body.key;
  expect(await eventSecrets(t.w.platform, t.settings.keys)).toEqual([s2, s1]);
  await t.w.advance(86_400_000);
  expect(await eventSecrets(t.w.platform, t.settings.keys)).toEqual([s2]);
  await t.admin(`/admin/keys/${info.id}/revoke`, {});
  expect(await eventSecrets(t.w.platform, t.settings.keys)).toEqual([]);
});

test("sessions: an account's names its generation; signing out everywhere, deleting, or a cross-origin write ends it", async () => {
  const t = await setup();
  const db = t.w.platform.db;
  await db.accounts.create({ username: "ann", password: null, sessions: 0, createdAt: T0 });
  const s = (await newSession(t.w.platform, t.settings.admin, "ann"))!;
  const req = (init: RequestInit = {}) => new Request("https://oc.test/admin/keys", { ...init, headers: { cookie: `a=1; ${sessionCookie(new Request("https://oc.test"), s.token, s.ttlMs).split(";")[0]}`, ...init.headers } });
  expect(await session(t.w.platform, t.settings.admin, req())).toEqual({ user: "ann", exp: T0 + s.ttlMs });
  // A session reaches the API and /admin.
  expect((await t.send("/admin/keys", { headers: req().headers })).status).toBe(200);
  expect((await t.send("/connections/keyed/k1", { headers: req().headers })).status).toBe(404);
  // Writes need this deployment's Origin.
  expect(await session(t.w.platform, t.settings.admin, req({ method: "POST" }))).toBe(null);
  expect(await session(t.w.platform, t.settings.admin, req({ method: "POST", headers: { origin: "https://evil.test" } }))).toBe(null);
  expect(await session(t.w.platform, t.settings.admin, req({ method: "POST", headers: { origin: "https://oc.test" } }))).not.toBe(null);

  await db.accounts.signOut("ann");
  expect(await session(t.w.platform, t.settings.admin, req())).toBe(null);
  const s2 = (await newSession(t.w.platform, t.settings.admin, "ann"))!;
  await db.accounts.delete("ann");
  expect(await session(t.w.platform, t.settings.admin, new Request("https://oc.test", { headers: { cookie: `connectd_session=${encodeURIComponent(s2.token)}` } }))).toBe(null);
});

test("sessions: a root one (from a CLI link) lasts an hour; cookies are Secure off localhost", async () => {
  const t = await setup();
  const s = (await newSession(t.w.platform, t.settings.admin, null))!;
  expect(s.ttlMs).toBe(ROOT_SESSION_MS);
  const c = sessionCookie(new Request("https://oc.test"), s.token, s.ttlMs);
  expect(c).toContain("HttpOnly; SameSite=Strict; Max-Age=3600; Secure");
  expect(sessionCookie(new Request("http://localhost:8787"), s.token, s.ttlMs)).not.toContain("Secure");
  const req = new Request("https://oc.test", { headers: { cookie: c.split(";")[0] as string } });
  expect(await session(t.w.platform, t.settings.admin, req)).toEqual({ user: null, exp: T0 + ROOT_SESSION_MS });
  await t.w.advance(ROOT_SESSION_MS);
  expect(await session(t.w.platform, t.settings.admin, req)).toBe(null);
  // Other tokens aren't sessions.
  const login = await token(t.settings.admin, "login", t.w.now(), 60_000);
  expect(await readToken(t.settings.admin, "session", login, t.w.now(), 60_000)).toBe(null);
});
