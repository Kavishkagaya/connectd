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
  const authorize = (t: string, fields: Record<string, string> = {}, origin: string | null = APP) =>
    send("/session/authorize", {
      method: "POST",
      headers: origin ? { origin } : {},
      body: new URLSearchParams({ token: t, mode: "popup", nonce: "n1", ...fields }),
    });
  /** The user approves at the provider, which redirects (in the same browser, with its cookie) to /callback. */
  const back = (location: string, cookie: string | null, extra = "") => {
    const b = p.approve(location);
    return send(`/callback?code=${b.code}&state=${encodeURIComponent(b.state)}${extra}`, cookie ? { headers: { cookie } } : {});
  };
  const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0] as string;
  const status = async (def: string, id: string) => (await json(await send(`/connections/${def}/${id}`, { headers: { authorization: "Bearer secret" } }))).body;
  return { p, w, settings, send, json, issue, token, browser, authorize, back, cookieOf, status };
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
  // Only the authorize route reaches session.authorize.
  const internal = await t.send("/connections/example/c1/session.authorize", { method: "POST", headers: { authorization: "Bearer secret" }, body: "{}" });
  expect(internal.status).toBe(404);
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

  // An OAuth definition doesn't take fields from the browser (it would skip the browser binding).
  const oauth = await t.json(await t.browser("/connect", await t.token(), { method: "POST", body: "{}" }));
  expect(oauth.status).toBe(400);
  expect(await t.json(await t.authorize(tk))).toMatchObject({ status: 400 });
});

test("popup: authorize sets the binding cookie, the callback posts to the opener on the bound origin", async () => {
  const t = await setup();
  const res = await t.authorize(await t.token());
  expect(res.status).toBe(303);
  const location = res.headers.get("location")!;
  expect(location).toStartWith("https://example.test/authorize?");
  expect(res.headers.get("set-cookie")).toMatch(/^oc-[\w-]+=[\w-]+; Path=\/callback; Max-Age=600; HttpOnly; Secure; SameSite=Lax$/);
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  expect((await t.status("example", "c1")).state).toBe("pending");

  const done = await t.back(location, t.cookieOf(res));
  expect(done.status).toBe(200);
  expect(done.headers.get("content-type")).toBe("text/html; charset=utf-8");
  const csp = done.headers.get("content-security-policy")!;
  const nonce = /'nonce-([\w-]+)'/.exec(csp)![1];
  const body = await done.text();
  expect(body).toContain(`<script nonce="${nonce}">`);
  expect(body).toContain(
    `window.opener.postMessage({"type":"openconnect","nonce":"n1","definition":"example","id":"c1","status":"connected"}, "${APP}")`,
  );
  expect(done.headers.get("set-cookie")).toContain("Max-Age=0");
  expect((await t.status("example", "c1")).state).toBe("active");
});

test("redirect: back to the bound return URL with the outcome; provider errors come back as a code", async () => {
  const t = await setup();
  const tk = await t.token("example", "c1", { returnUrl: `${APP}/done?x=1#top` });
  const res = await t.authorize(tk, { mode: "redirect" });
  const done = await t.back(res.headers.get("location")!, t.cookieOf(res));
  expect(done.status).toBe(303);
  expect(done.headers.get("location")).toBe(`${APP}/done?x=1&openconnect=connected#top`);

  const again = await t.authorize(tk, { mode: "redirect" });
  const st = new URL(again.headers.get("location")!).searchParams.get("state")!;
  const denied = await t.send(`/callback?error=access_denied&state=${encodeURIComponent(st)}`, { headers: { cookie: t.cookieOf(again) } });
  expect(denied.headers.get("location")).toBe(`${APP}/done?x=1&openconnect=error&code=access_denied#top`);

  // Redirect mode needs a bound return URL; there is no other place to send the browser.
  expect(await t.json(await t.authorize(await t.token(), { mode: "redirect" }))).toMatchObject({ status: 400 });
  // Errors before the provider (a revoked connection) end the same way.
  await t.send("/connections/example/c1/revoke", { method: "POST", headers: { authorization: "Bearer secret" } });
  const revoked = await t.authorize(tk, { mode: "redirect" });
  expect(revoked.headers.get("location")).toBe(`${APP}/done?x=1&openconnect=error&code=not_active#top`);
});

test("CSRF: only the app's page starts a flow, and only the browser that started it finishes it", async () => {
  const t = await setup();
  const tk = await t.token("example", "c1", { returnUrl: `${APP}/done` });
  // Another site's form (or a plain link) can't push a victim through this session.
  expect(await t.json(await t.authorize(tk, {}, "https://evil.test"))).toMatchObject({ status: 403, body: { error: { code: "forbidden" } } });
  expect((await t.authorize(tk, {}, null)).status).toBe(403);
  expect((await t.send("/session/authorize", { method: "GET" })).status).toBe(405);

  // The attacker starts a flow and sends the provider URL to a victim: the victim's browser has no cookie.
  const res = await t.authorize(tk, { mode: "redirect" });
  const loc = res.headers.get("location")!;
  const victim = await t.back(loc, null);
  expect(victim.headers.get("location")).toBe(`${APP}/done?openconnect=error&code=session_mismatch`);
  expect((await t.status("example", "c1")).state).toBe("pending");

  // Nor can the query smuggle a cookie header in.
  const res2 = await t.authorize(tk, { mode: "redirect" });
  const smuggled = await t.back(res2.headers.get("location")!, null, `&openconnect.cookies=${encodeURIComponent(t.cookieOf(res2))}`);
  expect(new URL(smuggled.headers.get("location")!).searchParams.get("code")).toBe("session_mismatch");
  // A wrong cookie value fails the same way.
  const res3 = await t.authorize(tk, { mode: "redirect" });
  const wrong = await t.back(res3.headers.get("location")!, `${t.cookieOf(res3).split("=")[0]}=guess`);
  expect(new URL(wrong.headers.get("location")!).searchParams.get("code")).toBe("session_mismatch");
  expect((await t.status("example", "c1")).state).toBe("pending");
});

test("open redirect: only the URL bound at issue, re-checked against the allowlist on the way back", async () => {
  const t = await setup();
  const tk = await t.token("example", "c1", { returnUrl: `${APP}/done` });
  const res = await t.authorize(tk, { mode: "redirect", returnUrl: "https://evil.test/" }); // form fields can't change it
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
  expect(done.status).toBe(400);
  const body = await done.text();
  expect(body).not.toContain("<img");
  expect(body).not.toContain("</script><");
  expect(body.slice(body.indexOf("<script"))).not.toContain("\u2028"); // a raw line separator ends a JS string in old engines
  expect(body.match(/<script/g)?.length).toBe(1);
  expect(body.match(/<\/script>/g)?.length).toBe(1);
  expect(body).toContain('"status":"error","code":"\\u003c/script\\u003e\\u003cimg');
  expect(body).toContain("&#60;/script&#62;&#60;img");
});

test("a callback without a session still answers JSON", async () => {
  const t = await setup();
  const c = await t.json(await t.send("/connections/example/c1/connect", { method: "POST", headers: { authorization: "Bearer secret" } }));
  const done = await t.json(await t.back(c.body.url, null));
  expect(done).toMatchObject({ status: 200, body: { state: "active", metadata: null } });
});
