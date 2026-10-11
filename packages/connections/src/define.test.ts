import { expect, test } from "bun:test";
import { base64url, importHmacKey, importKeys, type Json, type OAuth2, routeState } from "@openconnect/kernel";
import { memory } from "@openconnect/kernel/memory";
import { apiKey, oauth2 } from "./auth.ts";
import { bind, type Definition, defineConnection } from "./define.ts";

const k = (n: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(n)));
const H = 3_600_000;

// GitHub App user tokens: 8h access, rotating refresh, errors with a 200, dead refresh = bad_refresh_token.
const github = defineConnection({
  id: "github",
  auth: oauth2<{ clientId: string; clientSecret: string }>({
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    revokeUrl: "https://api.github.com/revoke",
    scopes: ["repo", "read:user"],
    invalidGrant: ["bad_refresh_token"],
  }),
  async metadata(ctx, cred) {
    const res = await ctx.fetch("https://api.github.com/user", { headers: { authorization: `Bearer ${(cred as OAuth2).accessToken}` } });
    if (!res.ok) throw new Error(`github /user ${res.status}`);
    return { login: ((await res.json()) as { login: string }).login };
  },
  rate: { connection: { count: 5000, periodMs: H } },
});

function fakeGitHub() {
  const gh = { codes: new Map<string, string>(), live: new Set<string>(), seq: 0, revoked: [] as string[] };
  const issue = () => {
    const n = ++gh.seq;
    gh.live.add(`r${n}`);
    return Response.json({ access_token: `a${n}`, refresh_token: `r${n}`, expires_in: 8 * 3600, token_type: "bearer" });
  };
  const fetch = (async (url: string, init: RequestInit = {}) => {
    if (url.endsWith("/user")) return Response.json({ login: "octocat" });
    const p = new URLSearchParams(init.body as URLSearchParams);
    if (url.endsWith("/revoke")) return gh.revoked.push(p.get("token")!), new Response(null);
    if (p.get("client_secret") !== "cs") return Response.json({ error: "incorrect_client_credentials" });
    if (p.get("grant_type") === "authorization_code") {
      const challenge = gh.codes.get(p.get("code")!);
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(p.get("code_verifier")!));
      if (!challenge || challenge !== base64url(new Uint8Array(digest)))
        return Response.json({ error: "bad_verification_code" });
      gh.codes.delete(p.get("code")!);
      return issue();
    }
    return gh.live.delete(p.get("refresh_token")!) ? issue() : Response.json({ error: "bad_refresh_token" });
  }) as unknown as typeof globalThis.fetch;
  /** The user approves on github.com, which redirects back with a code bound to the PKCE challenge. */
  const approve = (url: string) => {
    const u = new URL(url);
    const code = crypto.randomUUID();
    gh.codes.set(code, u.searchParams.get("code_challenge")!);
    return { code, state: u.searchParams.get("state")! };
  };
  return { gh, fetch, approve };
}

async function setup<C, M extends Json>(def: Definition<C, M>, config: C, fetch: typeof globalThis.fetch) {
  const opts = { config, fetch, redirectUri: "https://oc.test/callback", keys: await importKeys({ 1: k(1) }, 1), stateKey: await importHmacKey(k(9)) };
  const bound = new Map<string, ReturnType<typeof bind<C, M>>>();
  const w = memory((d, id) => {
    const b = bind(def, d, id, opts);
    bound.set(id, b);
    return { onCall: async () => null, onTimer: async (n, p) => void (await b.onTimer(n, p)) };
  });
  const get = async (id: string) => {
    await w.call(id, "init", null);
    return bound.get(id)!;
  };
  /** The public /callback route: route by state, no lookup. */
  const callback = async (q: { state: string; code: string }) => {
    const r = await routeState(q.state, opts.stateKey);
    if (!r) throw new Error("bad state");
    return (await get(r.instance)).callback(q);
  };
  return { w, get, callback };
}

test("github: connect, callback, metadata, refresh with rotation, provider revoke", async () => {
  const { gh, fetch, approve } = fakeGitHub();
  const { w, get, callback } = await setup(github, { clientId: "cid", clientSecret: "cs" }, fetch);
  const c = await get("conn:a");

  const url = new URL((await c.connect())!);
  expect(url.searchParams.get("scope")).toBe("repo read:user");
  expect(url.searchParams.get("redirect_uri")).toBe("https://oc.test/callback");
  expect((await c.conn.read())?.state).toBe("pending");

  const back = approve(url.toString());
  await callback(back);
  expect(await c.metadata()).toEqual({ login: "octocat" });
  expect(((await c.token()) as OAuth2).accessToken).toBe("a1");
  await expect(callback(back)).rejects.toThrow("unknown or expired state");

  // Timer refresh before the 8h expiry, following rotation.
  await w.advance(8 * H);
  expect(((await c.token()) as OAuth2).accessToken).toBe("a2");

  await c.revoke("user");
  expect(gh.revoked).toEqual(["r2"]);
  await expect(c.connect()).rejects.toThrow("revoked");
});

test("github quirk: bad_refresh_token means reauth_required, re-auth keeps the connection", async () => {
  const { gh, fetch, approve } = fakeGitHub();
  const { get, callback } = await setup(github, { clientId: "cid", clientSecret: "cs" }, fetch);
  const c = await get("conn:a");
  await callback(approve((await c.connect())!));
  gh.live.clear(); // refresh token revoked on github.com
  await expect(c.conn.refresh()).rejects.toMatchObject({ state: "reauth_required", reason: "invalid_grant" });

  await callback(approve((await c.connect())!));
  expect(((await c.token()) as OAuth2).accessToken).toBe("a2");
  expect((await c.conn.events.pending()).map((e) => e.to)).toEqual(["pending", "active", "reauth_required", "active"]);
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
  const { get } = await setup(def, null, fetch);

  const c = await get("conn:b");
  await expect(c.connect({})).rejects.toThrow("missing apiKey");
  await expect(c.connect({ apiKey: "bad" })).rejects.toThrow("invalid api key");
  expect(await c.conn.read()).toBe(null);
  expect(await c.connect({ apiKey: "good" })).toBe(null);
  expect(await c.metadata()).toEqual({ account: "acct_1" });
  expect(await c.token()).toEqual({ kind: "static", fields: { apiKey: "good" } });
});
