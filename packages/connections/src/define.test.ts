import { expect, test } from "bun:test";
import { type OAuth2 } from "./lifecycle.ts";
import { OAuthError } from "./oauth.ts";
import { apiKey, oauth2 } from "./auth.ts";
import { defineConnection, rateHeaders } from "./define.ts";
import { fakeOAuth, harness } from "./testing.ts";

const H = 3_600_000;
const TOKEN = "https://example.test/token";

const example = defineConnection({
  id: "example",
  auth: oauth2<{ clientId: string; clientSecret: string; scopes?: string[] }>({
    authorizeUrl: "https://example.test/authorize",
    tokenUrl: TOKEN,
    revokeUrl: "https://example.test/revoke",
    scopes: ["read"],
    invalidGrant: ["bad_refresh_token"],
  }),
  async metadata(ctx, cred) {
    const res = await ctx.fetch("https://example.test/me", { headers: { authorization: `Bearer ${(cred as OAuth2).accessToken}` } });
    if (!res.ok) throw new Error(`/me ${res.status}`);
    return (await res.json()) as { id: string };
  },
});

const provider = () =>
  fakeOAuth({
    tokenUrl: TOKEN,
    clientSecret: "cs",
    issue: (n) => ({ access_token: `a${n}`, refresh_token: `r${n}`, expires_in: 3600 }),
    // A provider with its own name for a dead refresh token, sent with a 200.
    error: (code) => ({ status: 200, body: { error: code === "invalid_grant" ? "bad_refresh_token" : "bad_verification_code" } }),
    route: (url) => (url.endsWith("/me") ? Response.json({ id: "u1" }) : new Response(null)),
  });

test("oauth2: connect, callback, metadata, timer refresh with rotation, provider revoke", async () => {
  const p = provider();
  const { w, get, callback } = await harness(example, { clientId: "cid", clientSecret: "cs" }, p.fetch);
  const c = await get("conn:a");

  const url = new URL((await c.connect())!);
  expect(url.searchParams.get("scope")).toBe("read");
  expect(url.searchParams.get("redirect_uri")).toBe("https://oc.test/callback");
  expect((await c.conn.read())?.state).toBe("pending");

  const back = p.approve(url.toString());
  await callback(back);
  expect(await c.metadata()).toEqual({ id: "u1" });
  expect(((await c.token()) as OAuth2).accessToken).toBe("a1");
  await expect(callback(back)).rejects.toThrow("unknown or expired state");

  await w.advance(H);
  expect(((await c.token()) as OAuth2).accessToken).toBe("a2");

  await c.revoke("user");
  const revoked = p.s.requests.find((r) => r.url.endsWith("/revoke"))!;
  expect(new URLSearchParams(await revoked.text()).get("token")).toBe("r2");
  await expect(c.connect()).rejects.toThrow("revoked");
});

test("oauth2: config scopes override the definition's, input overrides both; callback errors surface", async () => {
  const p = provider();
  const { get, callback } = await harness(example, { clientId: "cid", clientSecret: "cs", scopes: ["a", "b"] }, p.fetch);
  const c = await get("conn:a");
  expect(new URL((await c.connect())!).searchParams.get("scope")).toBe("a b");
  const url = (await c.connect({ scope: "x" }))!;
  expect(new URL(url).searchParams.get("scope")).toBe("x");
  await expect(callback({ state: p.approve(url).state, error: "access_denied" })).rejects.toBeInstanceOf(OAuthError);
});

test("oauth2: provider's dead-refresh code means reauth_required; re-auth keeps the connection", async () => {
  const p = provider();
  const { get, callback } = await harness(example, { clientId: "cid", clientSecret: "cs" }, p.fetch);
  const c = await get("conn:a");
  await callback(p.approve((await c.connect())!));
  p.s.live.clear();
  await expect(c.conn.refresh()).rejects.toMatchObject({ state: "reauth_required", reason: "invalid_grant" });

  await callback(p.approve((await c.connect())!));
  expect(((await c.token()) as OAuth2).accessToken).toBe("a2");
  expect((await c.conn.record.outbox.pending()).map((e) => e.msg.to)).toEqual(["pending", "active", "reauth_required", "active"]);
});

test("api key: inline connect, metadata rejects a bad key", async () => {
  const def = defineConnection({
    id: "acme",
    auth: apiKey(["apiKey"]),
    async metadata(ctx, cred) {
      const res = await ctx.fetch("https://acme.test/me", { headers: { authorization: `Bearer ${cred.kind === "static" ? cred.fields.apiKey : ""}` } });
      if (!res.ok) throw new Error("invalid api key");
      return { account: "acct_1" };
    },
  });
  const fetch = (async (_u: string, init: RequestInit) =>
    new Headers(init.headers).get("authorization") === "Bearer good" ? new Response("{}") : new Response(null, { status: 401 })) as unknown as typeof globalThis.fetch;
  const { get } = await harness(def, null, fetch);

  const c = await get("conn:b");
  await expect(c.connect({})).rejects.toThrow("missing apiKey");
  await expect(c.connect({ apiKey: "bad" })).rejects.toThrow("invalid api key");
  expect(await c.conn.read()).toBe(null);
  expect(await c.connect({ apiKey: "good" })).toBe(null);
  expect(await c.metadata()).toEqual({ account: "acct_1" });
  expect(await c.token()).toEqual({ kind: "static", fields: { apiKey: "good" } });
});

test("rateHeaders: retry-after seconds or date, named remaining/reset", () => {
  const now = Date.parse("2026-10-11T00:00:00Z");
  const h = (o: Record<string, string>) => new Response(null, { headers: o });
  expect(rateHeaders(h({ "retry-after": "30" }), now)).toEqual({ retryAfterMs: 30_000 });
  expect(rateHeaders(h({ "retry-after": "Sun, 11 Oct 2026 00:01:00 GMT" }), now)).toEqual({ retryAfterMs: 60_000 });
  const names = { remaining: "x-ratelimit-remaining", reset: "x-ratelimit-reset" };
  expect(rateHeaders(h({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1791676800" }), now, names)).toEqual({ remaining: 0, resetAt: 1791676800_000 });
  expect(rateHeaders(h({}), now, names)).toEqual({});
});
