import { expect, test } from "bun:test";
import { fakeOAuth, harness } from "@openconnect/connections/testing";
import { base64url, type Json, type OAuth2 } from "@openconnect/kernel";
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
