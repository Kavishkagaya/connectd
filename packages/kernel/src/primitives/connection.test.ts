import { expect, test } from "bun:test";
import { connection, IllegalTransition, NotActive, type OAuth2, type Options, routeState } from "./connection.ts";
import { memory } from "../drivers/memory.ts";
import { OAuthError, type TokenResponse } from "./oauth.ts";
import { importHmacKey, importKeys } from "./secrets.ts";

const k = (n: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(n)));
const H = 3_600_000;

async function setup(refresh?: Options["refresh"]) {
  const opts: Options = { keys: await importKeys({ 1: k(1) }, 1), stateKey: await importHmacKey(k(9)), refresh };
  const conns = new Map<string, ReturnType<typeof connection>>();
  const w = memory((d, id) => {
    const c = connection(d, id, opts);
    conns.set(id, c);
    return { onCall: async () => null, onTimer: async (n, p) => void (await c.onTimer(n, p)) };
  });
  const get = async (id = "c1") => {
    await w.call(id, "init", null);
    return conns.get(id)!;
  };
  return { w, get, opts };
}

const oauth = (access: string, refresh: string, expiresIn = 3600): TokenResponse => ({
  access_token: access,
  refresh_token: refresh,
  expires_in: expiresIn,
});

test("lifecycle: legal transitions, events, revoked is terminal", async () => {
  const { get } = await setup();
  const c = await get();
  expect(await c.read()).toBe(null);
  expect(await c.events.seq()).toBe(0);
  await expect(c.write(null, "reauth_required", null)).rejects.toBeInstanceOf(IllegalTransition);
  await expect(c.write(null, "active", null)).rejects.toBeInstanceOf(IllegalTransition);
  expect(await c.write(null, "pending", null)).toBe(true);
  expect(await c.write(null, "pending", null)).toBe(false); // lost the cas
  await c.activate({ kind: "static", fields: { apiKey: "sk" } });
  expect((await c.token()) as unknown).toEqual({ kind: "static", fields: { apiKey: "sk" } });
  await c.revoke("user");
  await expect(c.token()).rejects.toBeInstanceOf(NotActive);
  await expect(c.activate({ kind: "static", fields: {} })).rejects.toBeInstanceOf(IllegalTransition);
  const ev = await c.events.pending();
  expect(ev.map((e) => [e.seq, e.from, e.to, e.reason ?? null])).toEqual([
    [1, null, "pending", null],
    [2, "pending", "active", null],
    [3, "active", "revoked", "user"],
  ]);
  await c.events.ack(2);
  expect((await c.events.pending()).map((e) => e.seq)).toEqual([3]);
  expect(await c.events.seq()).toBe(3); // acks don't move it
});

test("handshake: signed state routes, take is once, other instance and forgery rejected", async () => {
  const { get, opts } = await setup();
  const c1 = await get("c1");
  const c2 = await get("c2");
  const state = await c1.handshake.open({ verifier: "v" });
  expect(await routeState(state, opts.stateKey)).toEqual({ instance: "c1", id: expect.any(String) });
  expect(await routeState(`${state}x`, opts.stateKey)).toBe(null);
  expect(await c2.handshake.take(state)).toBe(null);
  const both = await Promise.all([c1.handshake.take(state), c1.handshake.take(state)]);
  expect(both.filter((x) => x !== null)).toEqual([{ verifier: "v" }]);
});

test("handshake expires", async () => {
  const { w, get } = await setup();
  const c = await get();
  const state = await c.handshake.open({ x: 1 }, 1000);
  await w.advance(1000);
  expect(await c.handshake.take(state)).toBe(null);
});

test("tokens: single-flight refresh with rotation, timer-driven before expiry", async () => {
  let calls = 0;
  const { w, get } = await setup(async (cred) => {
    calls++;
    await Promise.resolve();
    return oauth(`a${calls + 1}`, `${cred.refreshToken}'`);
  });
  const c = await get();
  await c.activate({ kind: "oauth2", accessToken: "a1", refreshToken: "r", expiresAt: w.now() + H, raw: {} });
  // Concurrent refreshes share one provider call.
  const [x, y] = await Promise.all([c.refresh(), c.refresh()]);
  expect(calls).toBe(1);
  expect(x).toEqual(y);
  expect((x as OAuth2).refreshToken).toBe("r'");
  // Next refresh is armed ~5 min before expiry.
  await w.advance(H - 6 * 60_000);
  expect(calls).toBe(1);
  await w.advance(60_000);
  expect(calls).toBe(2);
  expect(((await c.token()) as OAuth2).refreshToken).toBe("r''");
});

test("tokens: a lost cas (event ack) does not drop a rotated refresh token", async () => {
  let ack: (() => Promise<void>) | undefined;
  const { w, get } = await setup(async () => {
    await ack?.();
    return oauth("a2", "r2");
  });
  const c = await get();
  await c.activate({ kind: "oauth2", accessToken: "a1", refreshToken: "r1", expiresAt: w.now() + H, raw: {} });
  ack = () => c.events.ack(99); // bumps the record version mid-refresh
  expect(((await c.refresh()) as OAuth2).refreshToken).toBe("r2");
  expect(((await c.read())?.credential as OAuth2).refreshToken).toBe("r2");
});

test("tokens: invalid_grant -> reauth_required, then re-auth back to active", async () => {
  const { w, get } = await setup(async () => {
    throw new OAuthError("invalid_grant", 400, null);
  });
  const c = await get();
  await c.activate({ kind: "oauth2", accessToken: "a1", refreshToken: "r1", expiresAt: w.now() + 30_000, raw: {} });
  await expect(c.token()).rejects.toMatchObject({ state: "reauth_required", reason: "invalid_grant" });
  expect((await c.read())?.credential).toBe(null);
  await c.activate({ kind: "oauth2", accessToken: "b", raw: {} });
  expect(((await c.token()) as OAuth2).accessToken).toBe("b");
  expect((await c.events.pending()).map((e) => e.to)).toEqual(["active", "reauth_required", "active"]);
});

test("tokens: transient failures retry with backoff, then give up to reauth_required", async () => {
  let calls = 0;
  const { w, get } = await setup(async () => {
    calls++;
    throw new Error("503");
  });
  const err = console.error;
  console.error = () => {};
  try {
    const c = await get();
    await c.activate({ kind: "oauth2", accessToken: "a1", refreshToken: "r1", expiresAt: w.now() + H, raw: {} });
    // Still valid: token() hands out the old token when a refresh in the skew window fails.
    await w.advance(H - 30_000 - 1);
    expect(calls).toBeGreaterThan(0);
    expect(((await c.token()) as OAuth2).accessToken).toBe("a1");
    for (let i = 0; i < 24; i++) await w.advance(H);
    expect(calls).toBe(9); // 8 timer attempts + the one token() made
    expect((await c.read())?.state).toBe("reauth_required");
    expect((await c.read())?.reason).toBe("refresh_failed");
  } finally {
    console.error = err;
  }
});

test("tokens: expired without a refresh token -> reauth_required", async () => {
  const { w, get } = await setup();
  const c = await get();
  await c.activate({ kind: "oauth2", accessToken: "a", expiresAt: w.now() + 1000, raw: {} });
  expect(((await c.token()) as OAuth2).accessToken).toBe("a");
  await w.advance(1000);
  await expect(c.token()).rejects.toMatchObject({ reason: "expired" });
});

test("secrets: credential re-sealed under the current key on read", async () => {
  const { opts } = await setup();
  const keys2 = await importKeys({ 1: k(1), 2: k(2) }, 2);
  const onlyV2 = await importKeys({ 2: k(2) }, 2);
  // One instance, three views: written under v1, read under v1+v2 (rewraps), then v2 alone works.
  const w = memory((d, id) => {
    const views = [opts, { ...opts, keys: keys2 }, { ...opts, keys: onlyV2 }].map((o) => connection(d, id, o));
    return {
      async onCall(m) {
        const c = views[Number(m)]!;
        if (m === "0") await c.activate({ kind: "static", fields: { k: "v" } });
        return ((await c.token()) as unknown as { fields: { k: string } }).fields.k;
      },
      onTimer: async () => {},
    };
  });
  expect(await w.call("c", "0", null)).toBe("v");
  await expect(w.call("c", "2", null)).rejects.toThrow();
  expect(await w.call("c", "1", null)).toBe("v");
  expect(await w.call("c", "2", null)).toBe("v");
});

test("refresh timer is cancelled on revoke", async () => {
  let calls = 0;
  const { w, get } = await setup(async () => {
    calls++;
    return oauth("x", "y");
  });
  const c = await get();
  await c.activate({ kind: "oauth2", accessToken: "a", refreshToken: "r", expiresAt: w.now() + H, raw: {} });
  await c.revoke();
  await w.advance(2 * H);
  expect(calls).toBe(0);
});
