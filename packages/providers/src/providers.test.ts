import { expect, test } from "bun:test";
import { hmacHex, type OAuth2 } from "@openconnect/connections";
import { fakeOAuth, harness } from "@openconnect/connections/testing";
import { base64url, type Json } from "@openconnect/kernel";
import { github } from "./github.ts";
import { google } from "./google.ts";
import { slack } from "./slack.ts";

const H = 3_600_000;
const access = async (c: { token(): Promise<unknown> }) => ((await c.token()) as OAuth2).accessToken;

test("github app: PKCE, 8h rotating tokens, bad_refresh_token -> reauth, grant revoke", async () => {
  const p = fakeOAuth({
    tokenUrl: "https://github.com/login/oauth/access_token",
    clientSecret: "cs",
    issue: (n) => ({ access_token: `ghu_${n}`, refresh_token: `r${n}`, expires_in: 28800, refresh_token_expires_in: 15897600, token_type: "bearer" }),
    error: (code) => ({ status: 200, body: { error: code === "invalid_grant" ? "bad_refresh_token" : "bad_verification_code" } }),
    route: (url, req) =>
      url === "https://api.github.com/user"
        ? req.headers.get("user-agent") ? Response.json({ id: 583231, login: "octocat" }) : new Response(null, { status: 403 })
        : new Response(null, { status: 204 }),
  });
  const { w, get, callback } = await harness(github, { clientId: "Iv1.abc", clientSecret: "cs" }, p.fetch);
  const c = await get("conn:gh");

  const url = new URL((await c.connect())!);
  expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  await callback(p.approve(url.toString()));
  expect(await c.metadata()).toEqual({ id: "583231", login: "octocat" });
  expect(await access(c)).toBe("ghu_1");

  await w.advance(8 * H);
  expect(await access(c)).toBe("ghu_2");

  p.s.live.clear();
  await expect(c.conn.refresh()).rejects.toMatchObject({ state: "reauth_required", reason: "invalid_grant" });
  await callback(p.approve((await c.connect())!));
  expect(await access(c)).toBe("ghu_3");

  await c.revoke();
  const del = p.s.requests.find((r) => r.method === "DELETE")!;
  expect(del.url).toBe("https://api.github.com/applications/Iv1.abc/grant");
  expect(del.headers.get("authorization")).toBe(`Basic ${btoa("Iv1.abc:cs")}`);
  expect(await del.json()).toEqual({ access_token: "ghu_3" });
});

const slackInstall = (n: number, userOnly: boolean) => ({
  ok: true,
  app_id: "A1",
  team: { id: "T9", name: "Acme" },
  enterprise: null,
  authed_user: { id: "U1", scope: "search:read", access_token: `xoxp-${n}`, token_type: "user" },
  ...(userOnly ? {} : { access_token: `xoxb-${n}`, token_type: "bot", scope: "chat:write,channels:read", bot_user_id: "B1" }),
});

test("slack: comma scopes + user_scope, no PKCE, bot token, team metadata, ok:false errors", async () => {
  const p = fakeOAuth({
    tokenUrl: "https://slack.com/api/oauth.v2.access",
    clientSecret: "cs",
    issue: (n) => slackInstall(n, false),
    error: (code) => ({ status: 200, body: { ok: false, error: code } }),
    route: () => Response.json({ ok: true, revoked: true }),
  });
  const config = { clientId: "1.2", clientSecret: "cs", scopes: ["chat:write", "channels:read"], userScopes: ["search:read"] };
  const { get, callback } = await harness(slack, config, p.fetch);
  const c = await get("conn:sl");

  const url = new URL((await c.connect())!);
  expect(url.searchParams.get("scope")).toBe("chat:write,channels:read");
  expect(url.searchParams.get("user_scope")).toBe("search:read");
  expect(url.searchParams.has("code_challenge")).toBe(false);

  await expect(callback({ state: url.searchParams.get("state")!, code: "nope" })).rejects.toMatchObject({ code: "invalid_code" });
  await callback(p.approve((await c.connect())!));
  expect(await access(c)).toBe("xoxb-1");
  expect(await c.metadata()).toEqual({ teamId: "T9", teamName: "Acme", userId: "U1", botUserId: "B1" });

  await c.revoke();
  expect(p.s.requests.at(-1)?.headers.get("authorization")).toBe("Bearer xoxb-1");
});

test("slack: user scopes only lifts the nested user token, with rotation", async () => {
  const p = fakeOAuth({
    tokenUrl: "https://slack.com/api/oauth.v2.access",
    issue: (n, grant): Json =>
      grant === "refresh_token"
        ? { ok: true, access_token: `xoxe.xoxp-${n}`, token_type: "user", refresh_token: `r${n}`, expires_in: 43200 }
        : {
            ok: true,
            team: { id: "T9", name: "Acme" },
            authed_user: { id: "U1", scope: "search:read", token_type: "user", access_token: `xoxe.xoxp-${n}`, refresh_token: `r${n}`, expires_in: 43200 },
          },
    error: (code) => ({ status: 200, body: { ok: false, error: code } }),
  });
  const { w, get, callback } = await harness(slack, { clientId: "1.2", clientSecret: "cs", scopes: [], userScopes: ["search:read"] }, p.fetch);
  const c = await get("conn:sl");
  const url = new URL((await c.connect())!);
  expect(url.searchParams.has("scope")).toBe(false);
  await callback(p.approve(url.toString()));
  expect(await access(c)).toBe("xoxe.xoxp-1");
  expect(await c.metadata()).toMatchObject({ teamId: "T9", userId: "U1", botUserId: null });
  await w.advance(12 * H);
  expect(await access(c)).toBe("xoxe.xoxp-2");
});

const idToken = (claims: object) => `e30.${base64url(new TextEncoder().encode(JSON.stringify(claims)))}.sig`;

test("google: offline + consent, PKCE, refresh keeps the unrotated refresh token, id_token metadata, revoke", async () => {
  const p = fakeOAuth({
    tokenUrl: "https://oauth2.googleapis.com/token",
    clientSecret: "cs",
    rotate: false,
    // Refreshes return no refresh_token.
    issue: (n, grant) => ({
      access_token: `ya29.${n}`,
      expires_in: 3599,
      token_type: "Bearer",
      scope: "openid email profile",
      ...(grant === "authorization_code" ? { refresh_token: `r${n}`, id_token: idToken({ sub: "1089", email: "a@b.test" }) } : {}),
    }),
    error: (code) => ({ status: 400, body: { error: code === "invalid_grant" ? "invalid_grant" : "invalid_request" } }),
    route: () => new Response(null),
  });
  const { w, get, callback } = await harness(google, { clientId: "x.apps.googleusercontent.com", clientSecret: "cs" }, p.fetch);
  const c = await get("conn:g");

  const url = new URL((await c.connect())!);
  expect(url.searchParams.get("access_type")).toBe("offline");
  expect(url.searchParams.get("prompt")).toBe("consent");
  expect(url.searchParams.get("scope")).toBe("openid email profile");
  expect(url.searchParams.get("code_challenge")).toBeTruthy();
  await callback(p.approve(url.toString()));
  expect(await c.metadata()).toEqual({ sub: "1089", email: "a@b.test" });

  await w.advance(H);
  expect(await access(c)).toBe("ya29.2");
  expect(((await c.token()) as OAuth2).refreshToken).toBe("r1");

  await c.revoke();
  const rv = p.s.requests.find((r) => r.url === "https://oauth2.googleapis.com/revoke")!;
  expect(new URLSearchParams(await rv.text()).get("token")).toBe("r1");
});

// Webhooks (#25): verify + parse are pure; register/unregister run against the fake provider.
const hook = (headers: Record<string, string>, body = "") => ({ headers: new Headers(headers), body });
const NOW = 1_700_000_000_000;
const at = { now: () => NOW };

test("github webhooks: X-Hub-Signature-256 with the connection's secret, ping is a handshake", async () => {
  const w = github.webhooks!;
  const body = JSON.stringify({ action: "opened", number: 1 });
  const sig = `sha256=${await hmacHex("s3cret", body)}`;
  const ok = hook({ "x-hub-signature-256": sig, "x-github-event": "pull_request", "x-github-delivery": "d-1" }, body);
  const ctx = { config: { clientId: "c" }, ...at };
  expect(await w.verify(ctx, ok, "s3cret")).toBe(true);
  expect(await w.verify(ctx, ok, "other")).toBe(false);
  expect(await w.verify(ctx, ok, null)).toBe(false); // app-level route: no secret, never valid
  expect(await w.verify(ctx, { ...ok, body: `${body} ` }, "s3cret")).toBe(false);
  expect(w.parse(ok)).toEqual({ topic: "pull_request", delivery: "d-1", payload: { action: "opened", number: 1 } });
  expect(w.parse(hook({ "x-github-event": "ping" }, "{}"))).toEqual({ reply: null });
  expect(github.webhooks!.register).toBeUndefined();
});

test("slack webhooks: v0 signing secret with a 5 min window, url_verification, routed by team", async () => {
  const w = slack.webhooks!;
  const config = { clientId: "1.2", signingSecret: "ss" };
  const body = JSON.stringify({ type: "event_callback", team_id: "T9", event_id: "Ev1", event: { type: "message", text: "hi" } });
  const signed = async (ts: number, b = body) => hook({ "x-slack-request-timestamp": String(ts), "x-slack-signature": `v0=${await hmacHex("ss", `v0:${ts}:${b}`)}` }, b);
  const ts = NOW / 1000;
  expect(await w.verify({ config, ...at }, await signed(ts), null)).toBe(true);
  expect(await w.verify({ config, ...at }, await signed(ts - 299), null)).toBe(true);
  expect(await w.verify({ config, ...at }, await signed(ts - 301), null)).toBe(false); // replay window
  expect(await w.verify({ config: { ...config, signingSecret: "other" }, ...at }, await signed(ts), null)).toBe(false);
  expect(await w.verify({ config: { clientId: "1.2" }, ...at }, await signed(ts), null)).toBe(false);
  expect(w.parse(await signed(ts))).toEqual({ topic: "message", delivery: "Ev1", external: { key: "teamId", value: "T9" }, payload: JSON.parse(body) });
  expect(w.parse(hook({}, JSON.stringify({ type: "url_verification", challenge: "abc" })))).toEqual({ reply: { challenge: "abc" } });
  // No team: nothing ties it to a connection, so it's refused (a 400 at the route) on either route.
  expect(() => w.parse(hook({}, JSON.stringify({ type: "event_callback", event: { type: "message" } })))).toThrow("no team_id");
  // Routes by what `external` indexes.
  expect(slack.external!({ teamId: "T9", teamName: "", userId: null, botUserId: null })).toEqual({ teamId: "T9" });
});

test("google webhooks: calendar channel registered with the secret as token, stopped on unregister", async () => {
  const calls: { url: string; body: any; auth: string | null }[] = [];
  const p = fakeOAuth({
    tokenUrl: "https://oauth2.googleapis.com/token",
    rotate: false,
    issue: (n) => ({ access_token: `ya29.${n}`, expires_in: 3599, refresh_token: `r${n}`, id_token: idToken({ sub: "1089" }) }),
    error: () => ({ status: 400, body: { error: "invalid_grant" } }),
    route: async (url, req) => {
      calls.push({ url, body: await req.json().catch(() => null), auth: req.headers.get("authorization") });
      return url.endsWith("/events/watch") ? Response.json({ kind: "api#channel", id: "ch1", resourceId: "res1", expiration: String(NOW + 7 * 86_400_000) }) : new Response(null, { status: 204 });
    },
  });
  const { get, callback } = await harness(google, { clientId: "x", watchCalendar: true }, p.fetch);
  const c = await get("conn:g");
  await callback(p.approve((await c.connect())!));
  const w = google.webhooks!;
  const cred = await c.token();
  const r = await w.register!(c.ctx, cred, { url: "https://oc.test/webhooks/google/g1", secret: "tok" });
  expect(r).toEqual({ hook: { id: "ch1", resourceId: "res1" }, expiresAt: NOW + 7 * 86_400_000 });
  expect(calls[0]).toMatchObject({ url: "https://www.googleapis.com/calendar/v3/calendars/primary/events/watch", auth: "Bearer ya29.1" });
  expect(calls[0]!.body).toMatchObject({ type: "web_hook", address: "https://oc.test/webhooks/google/g1", token: "tok" });
  await w.unregister!(c.ctx, cred, r!.hook);
  expect(calls[1]).toEqual({ url: "https://www.googleapis.com/calendar/v3/channels/stop", body: { id: "ch1", resourceId: "res1" }, auth: "Bearer ya29.1" });
  expect(await w.register!({ ...c.ctx, config: { clientId: "x" } }, cred, { url: "u", secret: "s" })).toBeNull(); // not opted in

  const n = hook({ "x-goog-channel-token": "tok", "x-goog-channel-id": "ch1", "x-goog-resource-state": "exists", "x-goog-resource-id": "res1", "x-goog-message-number": "2" });
  expect(await w.verify({ config: { clientId: "x" }, ...at }, n, "tok")).toBe(true);
  expect(await w.verify({ config: { clientId: "x" }, ...at }, n, "nope")).toBe(false);
  expect(w.parse(n)).toMatchObject({ topic: "calendar.exists", delivery: "ch1:2", payload: { channelId: "ch1", resourceId: "res1" } });
  expect(w.parse(hook({ "x-goog-resource-state": "sync" }))).toEqual({ reply: null });
});
