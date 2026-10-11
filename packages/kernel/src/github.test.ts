import { beforeEach, expect, test } from "bun:test";
import { type Credential, connection, credentialFrom } from "./connection.ts";
import { base64url, importAesKey, importHmacKey, type Keys, randomId, sign, verify } from "./crypto.ts";
import type { Json, Program } from "./index.ts";
import { memory } from "./memory.ts";
import { authorizeUrl, type Client, OAuthError, pkce, tokenRequest } from "./oauth.ts";

// GitHub App user tokens: 8h access token, rotating refresh token, errors returned with HTTP 200.
const AUTHORIZE = "https://github.com/login/oauth/authorize";
const TOKEN = "https://github.com/login/oauth/access_token";
const REFRESH_LEAD = 5 * 60_000;
const client: Client = { clientId: "cid", clientSecret: "csecret", redirectUri: "https://oc.test/callback" };

// --- fake GitHub -----------------------------------------------------------
let gh: { challenges: Map<string, string>; liveRefresh: Set<string>; tokenCalls: number; seq: number };
beforeEach(() => {
  gh = { challenges: new Map(), liveRefresh: new Set(), tokenCalls: 0, seq: 0 };
});
const issue = () => {
  const n = ++gh.seq;
  gh.liveRefresh.add(`r${n}`);
  return Response.json({ access_token: `a${n}`, refresh_token: `r${n}`, expires_in: 28800, token_type: "bearer" });
};
const fakeFetch = (async (_url: string, init: RequestInit) => {
  gh.tokenCalls++;
  await Promise.resolve(); // let concurrent callers interleave, like a real network hop
  const p = new URLSearchParams(init.body as URLSearchParams);
  if (p.get("client_secret") !== "csecret") return Response.json({ error: "incorrect_client_credentials" });
  if (p.get("grant_type") === "authorization_code") {
    const challenge = gh.challenges.get(p.get("code")!);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(p.get("code_verifier")!));
    if (challenge !== base64url(new Uint8Array(digest))) return Response.json({ error: "bad_verification_code" });
    gh.challenges.delete(p.get("code")!);
    return issue();
  }
  const r = p.get("refresh_token")!;
  if (!gh.liveRefresh.delete(r)) return Response.json({ error: "bad_refresh_token" });
  return issue();
}) as unknown as typeof fetch;

/** The user approves on github.com: GitHub redirects back with a code bound to the PKCE challenge. */
const approve = (url: string) => {
  const u = new URL(url);
  const code = randomId();
  gh.challenges.set(code, u.searchParams.get("code_challenge")!);
  return { code, state: u.searchParams.get("state")! };
};

// --- the flow, built only from kernel primitives ---------------------------
type Env = { keys: Keys; stateKey: CryptoKey };

const github =
  (env: Env): Program =>
  (d, id) => {
    const c = connection(d, env.keys);

    const save = async (prev: Awaited<ReturnType<typeof c.read>>, cred: Credential) => {
      if (!(await c.write(prev, "active", cred))) throw new Error("record changed concurrently");
      if (cred.expiresAt) await d.timer.set("refresh", cred.expiresAt - REFRESH_LEAD);
      return cred;
    };

    const refresh = () =>
      c.once("refresh", async () => {
        const r = await c.read();
        if (r?.state !== "active" || !r.credential?.refreshToken) throw new Error(`cannot refresh in ${r?.state}`);
        let tok: Record<string, Json>;
        try {
          tok = await tokenRequest(fakeFetch, TOKEN, client, {
            grant_type: "refresh_token",
            refresh_token: r.credential.refreshToken,
          });
        } catch (e) {
          if (e instanceof OAuthError && e.code === "bad_refresh_token") await c.write(r, "reauth_required", null);
          throw e;
        }
        return save(r, credentialFrom(tok, d.now(), r.credential));
      });

    return {
      async onCall(method, args) {
        const a = args as Record<string, string>;
        if (method === "connect") {
          const nonce = randomId();
          const { verifier, challenge } = await pkce();
          await c.handshake.open(nonce, { verifier }, 10 * 60_000);
          if (!(await c.read())) await c.write(null, "pending", null);
          return authorizeUrl(AUTHORIZE, client, {
            state: await sign(`${id}.${nonce}`, env.stateKey),
            scope: a.scope ?? "",
            code_challenge: challenge,
            code_challenge_method: "S256",
          });
        }
        if (method === "callback") {
          const hs = (await c.handshake.take(a.nonce!)) as { verifier: string } | null;
          if (!hs) throw new Error("unknown or expired state");
          const tok = await tokenRequest(fakeFetch, TOKEN, client, {
            grant_type: "authorization_code",
            code: a.code!,
            redirect_uri: client.redirectUri,
            code_verifier: hs.verifier,
          });
          await save(await c.read(), credentialFrom(tok, d.now()));
          return null;
        }
        if (method === "token") {
          const r = await c.read();
          if (r?.state !== "active" || !r.credential) throw new Error(`connection is ${r?.state ?? "missing"}`);
          const exp = r.credential.expiresAt;
          return exp !== undefined && exp - d.now() < 60_000 ? (await refresh()).accessToken : r.credential.accessToken;
        }
        if (method === "refresh") return (await refresh()).accessToken;
        if (method === "state") return (await c.read())?.state ?? null;
        if (method === "raw") return (await d.store.get("record"))?.value ?? null;
        throw new Error(`unknown method ${method}`);
      },
      async onTimer(name) {
        if (name === "refresh") await refresh().catch(() => {}); // ponytail: no retry/backoff yet (#11)
      },
    };
  };

// --- harness ----------------------------------------------------------------
const setup = async () => {
  const env: Env = {
    keys: { current: 1, byVersion: { 1: await importAesKey(btoa("k".repeat(32))) } },
    stateKey: await importHmacKey(btoa("s".repeat(32))),
  };
  const world = memory(github(env));
  /** The public /callback route: verify state, route to the instance it names. */
  const callback = async (q: { state: string; code: string }) => {
    const payload = await verify(q.state, env.stateKey);
    if (!payload) throw new Error("bad state");
    const dot = payload.lastIndexOf(".");
    return world.call(payload.slice(0, dot), "callback", { nonce: payload.slice(dot + 1), code: q.code });
  };
  const connect = async (id: string) => {
    const back = approve((await world.call(id, "connect", { scope: "repo" })) as string);
    await callback(back);
    return back;
  };
  return { world, callback, connect };
};

test("connect, callback, token; credential encrypted at rest", async () => {
  const { world, callback } = await setup();
  const url = new URL((await world.call("conn:a", "connect", { scope: "repo" })) as string);
  expect(url.searchParams.get("client_id")).toBe("cid");
  expect(await world.call("conn:a", "state", null)).toBe("pending");

  await callback(approve(url.toString()));
  expect(await world.call("conn:a", "state", null)).toBe("active");
  expect(await world.call("conn:a", "token", null)).toBe("a1");
  const raw = JSON.stringify(await world.call("conn:a", "raw", null));
  expect(raw).not.toContain("accessToken");
  expect(raw).not.toContain("refresh_token");
});

test("state is single-use and tamper-proof", async () => {
  const { callback, connect } = await setup();
  const back = await connect("conn:a");
  await expect(callback(back)).rejects.toThrow("unknown or expired state");
  await expect(callback({ ...back, state: `${back.state}x` })).rejects.toThrow("bad state");
});

test("handshake expires", async () => {
  const { world, callback } = await setup();
  const back = approve((await world.call("conn:a", "connect", {})) as string);
  await world.advance(10 * 60_000);
  await expect(callback(back)).rejects.toThrow("unknown or expired state");
});

test("timer refreshes before expiry and follows rotation", async () => {
  const { world, connect } = await setup();
  await connect("conn:a");
  await world.advance(8 * 3600_000 - REFRESH_LEAD - 1);
  expect(await world.call("conn:a", "token", null)).toBe("a1");
  await world.advance(1);
  expect(await world.call("conn:a", "token", null)).toBe("a2");
  await world.advance(8 * 3600_000);
  expect(await world.call("conn:a", "token", null)).toBe("a3");
  expect(gh.liveRefresh).toEqual(new Set(["r3"]));
});

test("concurrent refreshes share one token request", async () => {
  const { world, connect } = await setup();
  await connect("conn:a");
  const before = gh.tokenCalls;
  const results = await Promise.all([1, 2, 3].map(() => world.call("conn:a", "refresh", null)));
  expect(results).toEqual(["a2", "a2", "a2"]);
  expect(gh.tokenCalls - before).toBe(1);
});

test("dead refresh token moves to reauth_required, reconnect recovers", async () => {
  const { world, connect } = await setup();
  await connect("conn:a");
  gh.liveRefresh.clear(); // user revoked the app on github.com
  await expect(world.call("conn:a", "refresh", null)).rejects.toThrow("bad_refresh_token");
  expect(await world.call("conn:a", "state", null)).toBe("reauth_required");
  await expect(world.call("conn:a", "token", null)).rejects.toThrow("connection is reauth_required");
  await connect("conn:a");
  expect(await world.call("conn:a", "state", null)).toBe("active");
});
