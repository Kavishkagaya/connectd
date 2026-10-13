import { expect, test } from "bun:test";
import { apiKey, defineConnection, oauth2 } from "@openconnect/connections";
import { fakeOAuth } from "@openconnect/connections/testing";
import { importHmacKey, importKeys, type Json, sign } from "@openconnect/kernel";
import { memory } from "@openconnect/kernel/memory";
import { proxy, runtime, type Settings, sessions } from "./index.ts";

const TOKEN = "https://example.test/token";
const APP = "https://app.test";
const T0 = 1_700_000_000_000;
const key = (n: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(n)));

const example = defineConnection({
  id: "example",
  auth: oauth2<{ clientId: string; clientSecret: string }>({ authorizeUrl: "https://example.test/authorize", tokenUrl: TOKEN }),
  proxy: { baseUrl: "https://api.example.test" },
});
const keyed = defineConnection({ id: "keyed", auth: apiKey(["key", "region"]) });

async function setup(o: { sessions?: boolean } = {}) {
  const p = fakeOAuth({
    tokenUrl: TOKEN,
    clientSecret: "cs",
    issue: (n) => ({ access_token: `a${n}`, refresh_token: `r${n}`, expires_in: 3600 }),
    error: () => ({ status: 400, body: { error: "invalid_grant" } }),
  });
  const settings: Settings = {
    keys: await importKeys({ 1: key(1) }, 1),
    stateKey: await importHmacKey(key(9)),
    apiKey: "secret",
    redirectUri: "https://oc.test/callback",
    config: { example: { clientId: "cid", clientSecret: "cs" }, keyed: null },
    fetch: p.fetch,
    ...(o.sessions === false ? {} : { sessions: { key: await importHmacKey(key(5)), origins: [APP, "http://localhost:5173"] } }),
  };
  let w: ReturnType<typeof memory> | undefined;
  const rt = runtime({ definitions: { example, keyed }, settings: async () => settings, extensions: [sessions(), proxy()], now: () => w!.now() });
  w = memory(rt.program, { now: T0 });
  const send = (path: string, init: RequestInit = {}) => rt.fetch(new Request(`https://oc.test${path}`, init), w!.call);
  const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as any, headers: res.headers });

  /** The app's backend: `POST /connections/:def/:id/session` with the API key. */
  const issue = async (def: string, id: string, args: Json = { origin: APP }) =>
    json(await send(`/connections/${def}/${id}/session`, { method: "POST", headers: { authorization: "Bearer secret" }, body: JSON.stringify(args) }));
  const token = async (def = "example", id = "c1", args?: Json) => (await issue(def, id, args)).body.token as string;

  /** The browser, from the app's page. */
  const browser = (path: string, t: string, init: RequestInit = {}, origin = APP) =>
    send(`/session${path}`, { ...init, headers: { origin, authorization: `Bearer ${t}`, ...(init.headers as Record<string, string>) } });
  /** The page's fetch for a ticket (a CORS request: the browser always sends the page's real Origin). */
  const ticket = async (t: string, args: Json = { mode: "popup", nonce: "n1" }, origin = APP) =>
    json(await browser("/authorize", t, { method: "POST", body: JSON.stringify(args) }, origin));
  /** The popup or page navigates to the ticket: a top-level GET, no Origin, no Referer (a `no-referrer` page). */
  const go = (tk: string) => send(`/session/authorize?ticket=${encodeURIComponent(tk)}`);
  /** ticket + navigate: the 303 to the provider and the binding cookie. */
  const authorize = async (t: string, args: Json = { mode: "popup", nonce: "n1" }) => {
    const r = await ticket(t, args);
    if (r.status !== 200) throw new Error(`ticket ${r.status} ${JSON.stringify(r.body)}`);
    return go(r.body.ticket);
  };
  /** The popup page's message, as the opener receives it. */
  const message = (html: string) => JSON.parse(/postMessage\((\{.*?\}), "/.exec(html)![1]!);
  /** The app's page confirms what the callback handed it. */
  const confirm = async (t: string, completion: string, origin = APP) =>
    json(await browser("/complete", t, { method: "POST", body: JSON.stringify({ completion }) }, origin));
  /** The user approves at the provider, which redirects (in the same browser, with its cookie) to /callback. */
  const back = (location: string, cookie: string | null, extra = "") => {
    const b = p.approve(location);
    return send(`/callback?code=${b.code}&state=${encodeURIComponent(b.state)}${extra}`, cookie ? { headers: { cookie } } : {});
  };
  const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0] as string;
  const status = async (def: string, id: string) => (await json(await send(`/connections/${def}/${id}`, { headers: { authorization: "Bearer secret" } }))).body;
  return { p, w, settings, send, json, issue, token, browser, ticket, go, authorize, message, confirm, back, cookieOf, status };
}

test("issuing: scoped token with an expiry; origin and returnUrl must be allowlisted", async () => {
  const t = await setup();
  const ok = await t.issue("example", "c1", { returnUrl: `${APP}/settings?tab=1`, ttlMs: 60_000 });
  expect(ok.status).toBe(200);
  expect(ok.body.expiresAt).toBe(T0 + 60_000);
  // Readable, not secret: the browser package checks returnUrl for the redirect fallback.
  const claims = JSON.parse(Buffer.from(ok.body.token.split(".")[0], "base64url").toString());
  expect(claims).toEqual({ typ: "openconnect.session", def: "example", id: "c1", exp: T0 + 60_000, origin: APP, returnUrl: `${APP}/settings?tab=1` });
  expect((await t.issue("example", "c1", { origin: APP })).body.expiresAt).toBe(T0 + 600_000);

  const code = async (args: Json) => {
    const r = await t.issue("example", "c1", args);
    return [r.status, r.body.error.code];
  };
  expect(await code({})).toEqual([400, "bad_request"]);
  expect(await code({ origin: "https://evil.test" })).toEqual([403, "forbidden"]);
  expect(await code({ origin: `${APP}/` })).toEqual([400, "bad_request"]);
  expect(await code({ origin: APP, returnUrl: "https://evil.test/x" })).toEqual([403, "forbidden"]);
  expect(await code({ returnUrl: "javascript:alert(1)" })).toEqual([400, "bad_request"]);
  expect(await code({ returnUrl: "//evil.test" })).toEqual([400, "bad_request"]);
  expect(await code({ origin: APP, ttlMs: 2 * 3_600_000 })).toEqual([400, "bad_request"]);

  // The API key is required, and a revoked connection gets no session.
  expect((await t.send("/connections/example/c1/session", { method: "POST", body: JSON.stringify({ origin: APP }) })).status).toBe(401);
  await t.send("/connections/keyed/k1/connect", { method: "POST", headers: { authorization: "Bearer secret" }, body: JSON.stringify({ key: "k", region: "eu" }) });
  await t.send("/connections/keyed/k1/revoke", { method: "POST", headers: { authorization: "Bearer secret" } });
  expect((await t.issue("keyed", "k1")).body.error).toMatchObject({ code: "not_active", state: "revoked" });

  const off = await setup({ sessions: false });
  expect((await off.issue("example", "c1")).status).toBe(503);
  expect((await off.json(await off.browser("", "x"))).status).toBe(503);
});

test("GET /session: what to render, with CORS for the bound origin only", async () => {
  const t = await setup();
  const tk = await t.token();
  const info = await t.json(await t.browser("", tk));
  expect(info.status).toBe(200);
  expect(info.body).toEqual({ definition: "example", id: "c1", flow: "redirect", fields: [], state: null, expiresAt: T0 + 600_000 });
  expect(info.headers.get("access-control-allow-origin")).toBe(APP);
  expect(info.headers.get("vary")).toBe("Origin");

  const k = await t.json(await t.browser("", await t.token("keyed", "k1")));
  expect(k.body).toMatchObject({ flow: "form", fields: ["key", "region"], state: null });

  // Another allowlisted origin can't use a token bound to APP; an unknown one gets no CORS at all.
  const other = await t.json(await t.browser("", tk, {}, "http://localhost:5173"));
  expect(other.status).toBe(403);
  expect(other.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
  const evil = await t.json(await t.browser("", tk, {}, "https://evil.test"));
  expect([evil.status, evil.headers.get("access-control-allow-origin")]).toEqual([403, null]);

  // Preflight: allowlisted origins only.
  const pre = await t.send("/session/connect", { method: "OPTIONS", headers: { origin: APP, "access-control-request-method": "POST" } });
  expect(pre.status).toBe(204);
  expect(pre.headers.get("access-control-allow-headers")).toBe("authorization, content-type");
  expect((await t.send("/session", { method: "OPTIONS", headers: { origin: "https://evil.test" } })).status).toBe(403);

  // Forged, wrong-kind and expired tokens.
  expect((await t.json(await t.browser("", "nope"))).body.error.code).toBe("unauthorized");
  const state = await sign(JSON.stringify(["conn:example:c1", "x"]), t.settings.stateKey);
  expect((await t.json(await t.browser("", state))).status).toBe(401);
  const other5 = await sign(JSON.stringify({ typ: "openconnect.session", def: "example", id: "c2", exp: T0 + 1e9, origin: APP }), t.settings.stateKey);
  expect((await t.json(await t.browser("", other5))).status).toBe(401);
  await t.w.advance(600_000);
  const expired = await t.json(await t.browser("", tk));
  expect([expired.status, expired.body.error.code]).toEqual([401, "session_expired"]);
  expect(expired.headers.get("access-control-allow-origin")).toBe(APP);
});


test("garbage tokens, tickets and states are a 401/400, never a 500", async () => {
  const t = await setup();
  for (const bad of ["%%%.%%%", "a.b", "....", "eyJ.é"]) {
    expect((await t.json(await t.browser("", bad))).status).toBe(401);
    expect((await t.go(bad)).status).toBe(401);
    expect((await t.send(`/callback?state=${encodeURIComponent(bad)}`)).status).toBe(400);
  }
});

test("a session token is not an API key: no token(), no proxy, no admin routes, no internal method", async () => {
  const t = await setup();
  const tk = await t.token("keyed", "k1");
  await t.json(await t.browser("/connect", tk, { method: "POST", body: JSON.stringify({ fields: { key: "sk", region: "eu" } }) }));
  for (const [method, path] of [
    ["POST", "/connections/keyed/k1/token"],
    ["GET", "/connections/keyed/k1"],
    ["GET", "/proxy/keyed/k1/x"],
  ] as const)
    expect((await t.send(path, { method, headers: { origin: APP, authorization: `Bearer ${tk}` } })).status).toBe(401);
  // Only the session routes reach the internal methods.
  for (const m of ["session.ticket", "session.authorize", "session.complete"]) {
    const internal = await t.send(`/connections/example/c1/${m}`, { method: "POST", headers: { authorization: "Bearer secret" }, body: "{}" });
    expect(internal.status).toBe(404);
  }
});

test("API-key form through the session: fields in, state out (no metadata, no credential)", async () => {
  const t = await setup();
  const tk = await t.token("keyed", "k1");
  const missing = await t.json(await t.browser("/connect", tk, { method: "POST", body: JSON.stringify({ fields: { key: "sk" } }) }));
  expect([missing.status, missing.body.error.code, missing.headers.get("access-control-allow-origin")]).toEqual([400, "bad_request", APP]);
  expect(missing.body.error.message).toBe("missing region");
  expect((await t.json(await t.browser("/connect", tk, { method: "POST", body: JSON.stringify({ fields: { key: 1 } }) }))).status).toBe(400);

  const ok = await t.json(await t.browser("/connect", tk, { method: "POST", body: JSON.stringify({ fields: { key: "sk", region: "eu" } }) }));
  expect(ok).toMatchObject({ status: 200, body: { state: "active" } });
  expect(await t.status("keyed", "k1")).toEqual({ state: "active", metadata: null });

  // An OAuth definition doesn't take fields from the browser, nor an API-key one a ticket.
  expect((await t.json(await t.browser("/connect", await t.token(), { method: "POST", body: "{}" }))).status).toBe(400);
  expect((await t.ticket(tk)).status).toBe(400);
});

test("popup: ticket, then the provider; the callback hands a completion to the opener, which confirms it", async () => {
  const t = await setup();
  const tk = await t.token();
  const tic = await t.ticket(tk);
  expect([tic.status, typeof tic.body.ticket]).toEqual([200, "string"]);
  expect(tic.headers.get("access-control-allow-origin")).toBe(APP);
  // Navigation: no Origin, no Referer (the page may be `Referrer-Policy: no-referrer`); the ticket is what counts.
  const res = await t.go(tic.body.ticket);
  expect(res.status).toBe(303);
  const location = res.headers.get("location")!;
  expect(location).toStartWith("https://example.test/authorize?");
  expect(res.headers.get("set-cookie")).toMatch(/^oc-[\w-]+=[\w-]+; Path=\/callback; Max-Age=600; HttpOnly; Secure; SameSite=Lax$/);
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");

  const done = await t.back(location, t.cookieOf(res));
  expect(done.status).toBe(200);
  expect(done.headers.get("content-type")).toBe("text/html; charset=utf-8");
  const csp = done.headers.get("content-security-policy")!;
  const nonce = /'nonce-([\w-]+)'/.exec(csp)![1];
  const html = await done.text();
  expect(html).toContain(`<script nonce="${nonce}">`);
  expect(html).toContain(`, "${APP}"); window.close();`);
  const msg = t.message(html);
  const { completion, ...rest } = msg;
  expect(rest).toEqual({ type: "openconnect", nonce: "n1", definition: "example", id: "c1", status: "authorized" });
  expect(completion).toBeString();
  expect(done.headers.get("set-cookie")).toContain("Max-Age=0");
  // Exchanged, not activated: only the app's page activates it.
  expect((await t.status("example", "c1")).state).toBe("pending");
  expect(await t.confirm(tk, msg.completion)).toMatchObject({ status: 200, body: { state: "active" } });
  expect((await t.status("example", "c1")).state).toBe("active");
  expect((await t.confirm(tk, msg.completion)).body.error.code).toBe("bad_completion"); // single use
});

test("tickets: single use, 60 s, one connection; minted only from the session's origin", async () => {
  const t = await setup();
  const tk = await t.token();
  const tic = (await t.ticket(tk)).body.ticket as string;
  expect((await t.go(tic)).status).toBe(303);
  const reused = await t.go(tic);
  expect([reused.status, ((await reused.json()) as any).error.code]).toEqual([401, "bad_ticket"]);

  const late = (await t.ticket(tk)).body.ticket as string;
  await t.w.advance(60_000);
  expect((await t.go(late)).status).toBe(401);

  // The ticket names its connection; its id only exists in that connection's instance.
  const mine = (await t.ticket(tk)).body.ticket as string;
  const id = JSON.parse(Buffer.from(mine.split(".")[0]!, "base64url").toString()).t;
  const other = await sign(JSON.stringify({ typ: "openconnect.ticket", def: "example", id: "c2", t: id }), t.settings.sessions!.key);
  expect((await t.go(other)).status).toBe(401);
  // A session token isn't a ticket, nor the other way round.
  expect((await t.go(tk)).status).toBe(401);
  expect((await t.json(await t.browser("", mine))).status).toBe(401);

  // Minting is CORS from the token's origin: another origin, or a form page's `Origin: null`, is refused.
  expect((await t.ticket(tk, { mode: "popup", nonce: "" }, "https://evil.test")).status).toBe(403);
  expect((await t.ticket(tk, { mode: "popup", nonce: "" }, "null")).status).toBe(403);
  expect((await t.ticket(tk, { mode: "sideways" })).status).toBe(400);
  expect((await t.ticket(tk, { nonce: "<x>" })).status).toBe(400);
  expect((await t.ticket(tk, { mode: "redirect" })).status).toBe(400); // no returnUrl in the session
  expect((await t.send("/session/authorize", { method: "DELETE" })).status).toBe(405);
});

test("redirect: back to the bound return URL, the outcome in its fragment; provider errors come back as a code", async () => {
  const t = await setup();
  expect((await t.issue("example", "c1", { returnUrl: `${APP}/done#top` })).status).toBe(400); // the fragment is ours
  const tk = await t.token("example", "c1", { returnUrl: `${APP}/done?x=1` });
  const res = await t.authorize(tk, { mode: "redirect", nonce: "" });
  const done = await t.back(res.headers.get("location")!, t.cookieOf(res));
  expect(done.status).toBe(303);
  const back = new URL(done.headers.get("location")!);
  expect(`${back.origin}${back.pathname}${back.search}`).toBe(`${APP}/done?x=1`); // nothing for servers or Referers
  const f = new URLSearchParams(back.hash.slice(1));
  expect([f.get("openconnect"), f.get("definition"), f.get("id")]).toEqual(["authorized", "example", "c1"]);
  expect((await t.confirm(tk, f.get("completion")!)).body.state).toBe("active");

  const again = await t.authorize(tk, { mode: "redirect", nonce: "" });
  const st = new URL(again.headers.get("location")!).searchParams.get("state")!;
  const denied = await t.send(`/callback?error=access_denied&state=${encodeURIComponent(st)}`, { headers: { cookie: t.cookieOf(again) } });
  expect(denied.headers.get("location")).toBe(`${APP}/done?x=1#openconnect=error&definition=example&id=c1&code=access_denied`);

  // Errors before the provider (a revoked connection) end the same way.
  await t.send("/connections/example/c1/revoke", { method: "POST", headers: { authorization: "Bearer secret" } });
  const revoked = await t.authorize(tk, { mode: "redirect", nonce: "" });
  expect(revoked.headers.get("location")).toBe(`${APP}/done?x=1#openconnect=error&definition=example&id=c1&code=not_active`);
});

test("a completion is refused once the connection was revoked meanwhile, before the provider is called", async () => {
  const t = await setup();
  const tk = await t.token("example", "c1", { returnUrl: `${APP}/done` });
  const res = await t.authorize(tk, { mode: "redirect", nonce: "" });
  const done = await t.back(res.headers.get("location")!, t.cookieOf(res));
  await t.send("/connections/example/c1/revoke", { method: "POST", headers: { authorization: "Bearer secret" } });
  const calls = t.p.s.requests.length;
  const completion = new URLSearchParams(new URL(done.headers.get("location")!).hash.slice(1)).get("completion")!;
  expect((await t.confirm(tk, completion)).body.error).toMatchObject({ code: "not_active", state: "revoked" });
  expect(t.p.s.requests.length).toBe(calls);
});

test("popup without an opener (a provider's COOP cut it) goes on to the return URL", async () => {
  const t = await setup();
  const tk = await t.token("example", "c1", { returnUrl: `${APP}/done` });
  const res = await t.authorize(tk);
  const html = await (await t.back(res.headers.get("location")!, t.cookieOf(res))).text();
  expect(html).toMatch(/else if \("https:\/\/app\.test\/done#openconnect=authorized\\u0026definition=example\\u0026id=c1\\u0026completion=[\w-]+"\) location\.replace\(/);
});

test("login CSRF: a ticket minted elsewhere, opened in a victim's browser, never activates", async () => {
  const t = await setup();
  // The attacker has a session for their own connection (c1) and mints a ticket outside a browser, forging Origin.
  const attacker = await t.token("example", "c1", { returnUrl: `${APP}/done` });
  const forged = (await t.ticket(attacker, { mode: "redirect", nonce: "" })).body.ticket as string;
  // The victim opens the link: their browser gets the cookie and logs in at the provider...
  const res = await t.go(forged);
  const done = await t.back(res.headers.get("location")!, t.cookieOf(res));
  const completion = new URLSearchParams(new URL(done.headers.get("location")!).hash.slice(1)).get("completion")!;
  // ...and the completion lands on the app's page in the victim's browser, whose session is the victim's own (c2).
  const victim = await t.token("example", "c2");
  expect((await t.confirm(victim, completion)).body.error.code).toBe("bad_completion");
  // The attacker never sees it, and can't guess one.
  expect((await t.confirm(attacker, "guess")).body.error.code).toBe("bad_completion");
  expect((await t.status("example", "c1")).state).toBe("pending");

  // Sending the victim the provider URL instead: the victim's browser has no cookie.
  const own = await t.authorize(attacker, { mode: "redirect", nonce: "" });
  const loc = own.headers.get("location")!;
  expect((await t.back(loc, null)).headers.get("location")).toBe(`${APP}/done#openconnect=error&definition=example&id=c1&code=session_mismatch`);
  // Nor can the query smuggle a cookie header in, or a wrong cookie pass.
  const r2 = await t.authorize(attacker, { mode: "redirect", nonce: "" });
  const smuggled = await t.back(r2.headers.get("location")!, null, `&openconnect.cookies=${encodeURIComponent(t.cookieOf(r2))}`);
  expect(new URLSearchParams(new URL(smuggled.headers.get("location")!).hash.slice(1)).get("code")).toBe("session_mismatch");
  const r3 = await t.authorize(attacker, { mode: "redirect", nonce: "" });
  const wrong = await t.back(r3.headers.get("location")!, `${t.cookieOf(r3).split("=")[0]}=guess`);
  expect(new URLSearchParams(new URL(wrong.headers.get("location")!).hash.slice(1)).get("code")).toBe("session_mismatch");
  expect((await t.status("example", "c1")).state).toBe("pending");
});

test("open redirect: only the URL bound at issue, re-checked against the allowlist on the way back", async () => {
  const t = await setup();
  const tk = await t.token("example", "c1", { returnUrl: `${APP}/done` });
  const res = await t.authorize(tk, { mode: "redirect", nonce: "", returnUrl: "https://evil.test/" }); // the request can't change it
  t.settings.sessions!.origins = ["http://localhost:5173"]; // narrowed after the token was issued
  const done = await t.back(res.headers.get("location")!, t.cookieOf(res));
  expect(done.status).toBe(403);
  expect(done.headers.get("location")).toBeNull();
  expect(((await done.json()) as any).error.code).toBe("forbidden");
});

test("the popup page escapes what it shows and posts", async () => {
  const t = await setup();
  const res = await t.authorize(await t.token());
  const st = new URL(res.headers.get("location")!).searchParams.get("state")!;
  const evil = `</script><img src=x onerror=alert(1)>\u2028'"`;
  const done = await t.send(`/callback?error=${encodeURIComponent(evil)}&state=${encodeURIComponent(st)}`, { headers: { cookie: t.cookieOf(res) } });
  const body = await done.text();
  expect(body).not.toContain("<img");
  expect(body).not.toContain("</script><");
  expect(body.slice(body.indexOf("<script"))).not.toContain("\u2028"); // a raw line separator ends a JS string in old engines
  expect(body.match(/<script/g)?.length).toBe(1);
  expect(body.match(/<\/script>/g)?.length).toBe(1);
  expect(body).toContain('"status":"error","code":"\\u003c/script\\u003e\\u003cimg');
  expect(body).toContain("&#60;/script&#62;&#60;img");
});

test("a callback without a session still answers JSON and activates", async () => {
  const t = await setup();
  const c = await t.json(await t.send("/connections/example/c1/connect", { method: "POST", headers: { authorization: "Bearer secret" } }));
  const done = await t.json(await t.back(c.body.url, null));
  expect(done).toMatchObject({ status: 200, body: { state: "active", metadata: null } });
});
