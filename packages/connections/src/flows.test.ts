import { expect, test } from "bun:test";
import { base64url } from "@kavishkagaya/connectd-kernel";
import { connection, definitionOf } from "./builder.ts";
import { type Jwk, signJwt, verifyJwt } from "./jwt.ts";
import type { OAuth2 } from "./lifecycle.ts";
import { fakeOAuth, harness } from "./testing.ts";

const H = 3_600_000;
const ISSUER = "https://id.test";

async function rsa(kid: string) {
  const pair = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  const pem = (label: string, der: Uint8Array) => `-----BEGIN ${label}-----\n${btoa(String.fromCharCode(...der))}\n-----END ${label}-----\n`;
  const jwk = { ...((await crypto.subtle.exportKey("jwk", pair.publicKey)) as Jwk), kid, alg: "RS256" };
  // PKCS#1 is the key inside PKCS#8's octet string (a 2048-bit key's header is 26 bytes).
  return { key: pair.privateKey, jwk, pkcs8: pem("PRIVATE KEY", pkcs8), pkcs1: pem("RSA PRIVATE KEY", pkcs8.slice(26)) };
}

const json = (v: unknown) => Response.json(v);

test("oidc: discovery, nonce, id_token verified (keys refetched on rotation), claims as identity", async () => {
  const k1 = await rsa("k1");
  const k2 = await rsa("k2");
  let jwks: Jwk[] = [k1.jwk];
  let idToken = "";
  const p = fakeOAuth({
    tokenUrl: `${ISSUER}/token`,
    clientSecret: "cs",
    issue: (n) => ({ access_token: `a${n}`, refresh_token: `r${n}`, expires_in: 3600, id_token: idToken }),
    error: () => ({ status: 400, body: { error: "invalid_grant" } }),
    route: (url) =>
      url === `${ISSUER}/.well-known/openid-configuration`
        ? json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks` })
        : url === `${ISSUER}/jwks`
          ? json({ keys: jwks })
          : new Response(null, { status: 404 }),
  });
  const id = connection("id")
    .config<{ clientId: string; clientSecret: string }>()
    .auth((f) => f.oidc({ issuer: ISSUER }).scopes("email"))
    .external((c) => ({ sub: String(c.sub) }));
  const { get, callback } = await harness(id, { clientId: "cid", clientSecret: "cs" }, p.fetch);
  const sign = (claims: Record<string, unknown>, key = k1) => signJwt({ iss: ISSUER, aud: "cid", sub: "u1", exp: 10_000, ...claims } as never, key.key, { kid: key.jwk.kid });

  const login = async (conn: string, claims: (nonce: string) => Record<string, unknown>, key = k1) => {
    const c = await get(conn);
    const url = new URL((await c.connect())!);
    expect(url.origin + url.pathname).toBe(`${ISSUER}/authorize`);
    expect(url.searchParams.get("scope")).toBe("openid email");
    const nonce = url.searchParams.get("nonce")!;
    idToken = await sign(claims(nonce), key);
    return { c, done: callback(p.approve(url.toString())) };
  };

  const ok = await login("conn:a", (nonce) => ({ nonce, email: "a@b.c", custom: { x: 1 } }));
  await ok.done;
  // Every claim, not a subset.
  expect(await ok.c.metadata()).toMatchObject({ sub: "u1", email: "a@b.c", custom: { x: 1 }, iss: ISSUER });
  expect(definitionOf(id).external?.({ sub: "u1" })).toEqual({ sub: "u1" });

  for (const [why, claims] of [
    ["nonce", () => ({ nonce: "other" })],
    ["aud", (nonce: string) => ({ nonce, aud: "someone-else" })],
    ["iss", (nonce: string) => ({ nonce, iss: "https://evil.test" })],
    ["exp", (nonce: string) => ({ nonce, exp: -1000 })],
  ] as const) {
    const bad = await login(`conn:${why}`, claims);
    await expect(bad.done).rejects.toThrow("invalid_id_token");
    expect((await bad.c.conn.read())?.state).toBe("pending");
  }

  // The provider rotated to k2: the cached key set misses its kid, so it's fetched again once.
  jwks = [k2.jwk];
  const rotated = await login("conn:r", (nonce) => ({ nonce }), k2);
  await rotated.done;
  expect(((await rotated.c.token()) as OAuth2).raw.id_token).toBe(idToken);

  // Signed by a key the provider doesn't publish under that kid.
  const forged = await login("conn:f", (nonce) => ({ nonce }), { ...k1, jwk: { ...k1.jwk, kid: "k2" } });
  await expect(forged.done).rejects.toThrow("bad JWT signature");
});

test("client credentials: minted at connect, minted again before expiry with no refresh token", async () => {
  let n = 0;
  const fetch = (async (url: string, init?: RequestInit) => {
    const p = new URLSearchParams(String(init?.body));
    if (url !== "https://cc.test/token" || p.get("grant_type") !== "client_credentials" || p.get("client_secret") !== "cs") return json({ error: "invalid_client" });
    return json({ access_token: `t${++n}`, expires_in: 3600, scope: p.get("scope") });
  }) as typeof globalThis.fetch;
  const app = connection("app")
    .config<{ clientId: string; clientSecret: string }>()
    .auth((f) => f.clientCredentials({ tokenUrl: "https://cc.test/token" }).scopes("read", "write"));
  const { w, get } = await harness(app, { clientId: "cid", clientSecret: "cs" }, fetch);
  const c = await get("conn:app");
  expect(await c.connect()).toBeNull();
  const t1 = (await c.token()) as OAuth2;
  expect(t1.accessToken).toBe("t1");
  expect(t1.refreshToken).toBeUndefined();
  expect(t1.raw.scope).toBe("read write");

  await w.advance(H);
  expect(((await c.token()) as OAuth2).accessToken).toBe("t2");
  expect(n).toBe(2);
});

test("jwt bearer: a signed assertion (PKCS#8 key), subject kept across mints, rejected key -> reauth", async () => {
  const k = await rsa("sa");
  let n = 0;
  let disabled = false;
  const seen: Record<string, unknown>[] = [];
  const fetch = (async (_url: string, init?: RequestInit) => {
    const p = new URLSearchParams(String(init?.body));
    const claims = await verifyJwt(p.get("assertion") ?? "", [k.jwk]);
    if (!claims || disabled || p.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer" || p.has("client_id")) return json({ error: "invalid_grant" });
    seen.push(claims);
    return json({ access_token: `g${++n}`, expires_in: 3600 });
  }) as typeof globalThis.fetch;
  const sa = connection("sa")
    .config<{ clientEmail: string; privateKey: string }>()
    .auth((f) => f.jwtBearer({ tokenUrl: "https://oauth2.test/token" }).scopes("https://scope.test/drive"));
  const { w, get } = await harness(sa, { clientEmail: "bot@sa.test", privateKey: k.pkcs8 }, fetch);
  const c = await get("conn:sa");
  expect(await c.connect({ subject: "alice@org.test" })).toBeNull();
  expect(((await c.token()) as OAuth2).accessToken).toBe("g1");
  expect(seen[0]).toMatchObject({ iss: "bot@sa.test", aud: "https://oauth2.test/token", scope: "https://scope.test/drive", sub: "alice@org.test", iat: 0, exp: 3600 });

  await w.advance(H);
  expect(((await c.token()) as OAuth2).accessToken).toBe("g2");
  expect(seen[1]?.sub).toBe("alice@org.test");

  disabled = true;
  await expect(c.conn.refresh()).rejects.toMatchObject({ state: "reauth_required", reason: "invalid_grant" });
});

test("device flow: a code to show, polled on a timer (pending, slow_down), active once approved", async () => {
  let polls = 0;
  let approved = false;
  const fetch = (async (url: string, init?: RequestInit) => {
    const p = new URLSearchParams(String(init?.body));
    if (url === "https://dev.test/device")
      return json({ device_code: "dc", user_code: "WDJB-MJHT", verification_uri: "https://dev.test/activate", expires_in: 900, interval: 5 });
    if (p.get("grant_type") === "refresh_token") return json({ access_token: "d2", expires_in: 3600 });
    if (p.get("device_code") !== "dc") return json({ error: "invalid_grant" });
    polls++;
    if (polls === 2) return json({ error: "slow_down" });
    return json(approved ? { access_token: "d1", refresh_token: "r1", expires_in: 3600 } : { error: "authorization_pending" });
  }) as typeof globalThis.fetch;
  const tv = connection("tv")
    .config<{ clientId: string }>()
    .auth((f) => f.device({ deviceUrl: "https://dev.test/device", tokenUrl: "https://dev.test/token" }).scopes("profile"));
  const { w, get } = await harness(tv, { clientId: "cid" }, fetch);
  const c = await get("conn:tv");

  expect(await c.connect()).toBe("https://dev.test/activate");
  expect(await c.device()).toEqual({ userCode: "WDJB-MJHT", verificationUri: "https://dev.test/activate", expiresAt: 900_000, intervalMs: 5000 });
  expect((await c.conn.read())?.state).toBe("pending");

  await w.advance(5000); // pending
  await w.advance(5000); // slow_down: every 10 s from now on
  expect((await c.device())?.intervalMs).toBe(10_000);
  approved = true;
  await w.advance(5000);
  expect(polls).toBe(2);
  await w.advance(5000);
  expect(polls).toBe(3);
  expect((await c.conn.read())?.state).toBe("active");
  expect(await c.device()).toBeNull();
  expect(((await c.token()) as OAuth2).accessToken).toBe("d1");
});

test("device flow: an expired code stops polling and leaves the connection pending", async () => {
  let polls = 0;
  const fetch = (async (url: string) =>
    url === "https://dev.test/device"
      ? json({ device_code: "dc", user_code: "C", verification_uri: "https://dev.test/a", verification_uri_complete: "https://dev.test/a?c=C", expires_in: 12 })
      : (polls++, json({ error: "authorization_pending" }))) as typeof globalThis.fetch;
  const tv = connection("tv")
    .config<{ clientId: string }>()
    .auth((f) => f.device({ deviceUrl: "https://dev.test/device", tokenUrl: "https://dev.test/token" }));
  const { w, get } = await harness(tv, { clientId: "cid" }, fetch);
  const c = await get("conn:tv");
  expect(await c.connect()).toBe("https://dev.test/a?c=C");
  for (let i = 0; i < 5; i++) await w.advance(5000);
  expect(polls).toBe(2);
  expect(await c.device()).toBeNull();
  expect((await c.conn.read())?.state).toBe("pending");
});

test("jwt: PKCS#1 keys import (GitHub App keys), and a signature verifies", async () => {
  const { importPrivateKey } = await import("./jwt.ts");
  const k = await rsa("p1");
  const t = await signJwt({ iss: "123" }, await importPrivateKey(k.pkcs1));
  expect(await verifyJwt(t, [k.jwk])).toEqual({ iss: "123" });
  expect(base64url(new Uint8Array([1]))).toBe("AQ");
});

test("device flow: revoke stops polling; a reconnect wins over a poll that lands late; a network error is retried", async () => {
  let release: (r: Response) => void = () => {};
  let calls = 0;
  let down = false;
  const codes: string[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const p = new URLSearchParams(String(init?.body));
    if (url === "https://dev.test/device") {
      const dc = `dc${codes.length + 1}`;
      codes.push(dc);
      return json({ device_code: dc, user_code: dc.toUpperCase(), verification_uri: "https://dev.test/a", expires_in: 900, interval: 0 });
    }
    calls++;
    if (down) throw new TypeError("network down");
    const dc = p.get("device_code");
    // dc1 hangs until released; dc2 is approved; dc3 is pending forever.
    if (dc === "dc1") return new Promise<Response>((r) => (release = r));
    if (dc === "dc2") return json({ access_token: "fresh", refresh_token: "r", expires_in: 3600 });
    return json({ error: "authorization_pending" });
  }) as typeof globalThis.fetch;
  const tv = connection("tv")
    .config<{ clientId: string }>()
    .auth((f) => f.device({ deviceUrl: "https://dev.test/device", tokenUrl: "https://dev.test/token" }));
  const { w, get } = await harness(tv, { clientId: "cid" }, fetch);
  const c = await get("conn:tv");

  // interval 0 is clamped to the 5 s default.
  await c.connect();
  expect((await c.device())?.intervalMs).toBe(5000);
  const late = w.advance(5000); // dc1's poll is now in flight
  while (calls === 0) await new Promise((r) => setTimeout(r, 1));
  await c.connect(); // dc2 replaces it
  release(json({ access_token: "stale", refresh_token: "r", expires_in: 3600 }));
  await late;
  expect((await c.conn.read())?.state).toBe("pending");
  expect((await c.device())?.userCode).toBe("DC2");
  await w.advance(5000);
  expect((await c.conn.read())?.state).toBe("active");
  expect(((await c.token()) as OAuth2).accessToken).toBe("fresh");

  // A network error doesn't end the attempt: the next interval polls again.
  const d = await get("conn:tv2");
  await d.connect(); // dc3
  down = true;
  await w.advance(5000);
  expect((await d.device())?.userCode).toBe("DC3");
  down = false;
  const before = calls;
  await w.advance(5000);
  expect(calls).toBe(before + 1);

  // Revoke: the attempt is gone and nothing polls.
  await d.revoke();
  expect(await d.device()).toBeNull();
  const after = calls;
  await w.advance(5000);
  await w.advance(5000);
  expect(calls).toBe(after);
});

test("jwt: ES256, no kid (every fitting key tried), encryption keys skipped", async () => {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as Jwk;
  const input = `${base64url(new TextEncoder().encode(JSON.stringify({ alg: "ES256" })))}.${base64url(new TextEncoder().encode(JSON.stringify({ sub: "x" })))}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(input)));
  const es = `${input}.${base64url(sig)}`;
  const other = (await rsa("r")).jwk;
  expect(await verifyJwt(es, [other, { ...jwk, kid: "e1" }])).toEqual({ sub: "x" });
  expect(await verifyJwt(es, [{ ...jwk, use: "enc" }])).toBeNull();

  const a = await rsa("a");
  const b = await rsa("b");
  const t = await signJwt({ sub: "y" }, b.key);
  expect(await verifyJwt(t, [{ ...a.jwk, kid: undefined }, { ...b.jwk, kid: undefined }])).toEqual({ sub: "y" });
  await expect(verifyJwt(t, [{ ...a.jwk, kid: undefined }])).rejects.toThrow("bad JWT signature");
});
