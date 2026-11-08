import { expect, test } from "bun:test";
import { base64url } from "@kavishkagaya/connectd-kernel";
import { token } from "@kavishkagaya/connectd-runtime";
import { OC, setup } from "./fake.ts";
import { derToRaw } from "./webauthn.ts";

const utf8 = (s: string) => new TextEncoder().encode(s);
const sha = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", b as Uint8Array<ArrayBuffer>));
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) (out.set(p, i), (i += p.length));
  return out;
};

/** WebCrypto's ES256 signature (r || s) as an authenticator sends it: DER. */
function der(raw: Uint8Array) {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    const v = b.subarray(i);
    return (v[0] as number) & 0x80 ? cat(Uint8Array.of(0x02, v.length + 1, 0), v) : cat(Uint8Array.of(0x02, v.length), v);
  };
  const body = cat(int(raw.subarray(0, 32)), int(raw.subarray(32)));
  return cat(Uint8Array.of(0x30, body.length), body);
}

/** A software authenticator for `origin` (rp id: its host): one P-256 credential with a counter. */
async function authenticator(origin = OC) {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const id = base64url(crypto.getRandomValues(new Uint8Array(16)));
  let counter = 0;
  const data = async (flags: number) => cat(await sha(utf8(new URL(origin).hostname)), Uint8Array.of(flags), new Uint8Array(new Uint32Array([0]).buffer).map((_, i) => (counter >>> (8 * (3 - i))) & 0xff));
  const client = (type: string, challenge: string, o = origin) => utf8(JSON.stringify({ type, challenge: base64url(utf8(challenge)), origin: o }));
  return {
    id,
    async create(challenge: string, o?: { origin?: string; flags?: number }) {
      return {
        id,
        clientDataJSON: base64url(client("webauthn.create", challenge, o?.origin)),
        authenticatorData: base64url(await data(o?.flags ?? 0x45)),
        publicKey: base64url(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey))),
        alg: -7,
      };
    },
    /** `counter`: send this one (a clone's stale counter) instead of the next. */
    async get(challenge: string, o?: { origin?: string; counter?: number }) {
      counter = o?.counter ?? counter + 1;
      const auth = await data(0x05);
      const cd = client("webauthn.get", challenge, o?.origin);
      const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, cat(auth, await sha(cd)) as Uint8Array<ArrayBuffer>));
      return { id, clientDataJSON: base64url(cd), authenticatorData: base64url(auth), signature: base64url(der(sig)) };
    },
  };
}

/** Requests as a browser on this origin would make them, with a cookie jar. */
function browser(t: Awaited<ReturnType<typeof setup>>) {
  let cookie = "";
  const req = async (path: string, body?: unknown, o: { origin?: string } = {}) => {
    const res = await t.fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { origin: o.origin ?? OC, "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = /Max-Age=0/.test(set) ? "" : (set.split(";")[0] as string);
    return { status: res.status, body: (await res.json()) as any, set };
  };
  return { req, cookie: () => cookie, setCookie: (c: string) => void (cookie = c) };
}

test("a CLI link signs in once as root; root makes the first account and becomes it", async () => {
  const t = await setup();
  const b = browser(t);
  expect((await b.req("/dashboard/api/auth/me")).body).toBe(null);
  const tok = await t.loginToken();
  const login = await b.req("/dashboard/api/auth/login", { token: tok });
  expect(login.status).toBe(200);
  expect(login.set).toContain("HttpOnly; SameSite=Strict; Max-Age=3600; Secure");
  expect((await b.req("/dashboard/api/auth/me")).body).toMatchObject({ user: null, root: true, accounts: 0 });
  // Used once.
  expect((await browser(t).req("/dashboard/api/auth/login", { token: tok })).status).toBe(401);
  // Not from another site, and not any other token.
  expect((await browser(t).req("/dashboard/api/auth/login", { token: await t.loginToken() }, { origin: "https://evil.test" })).status).toBe(403);
  expect((await browser(t).req("/dashboard/api/auth/login", { token: await token(t.settings.admin, "invite", t.w.now(), 60_000) })).status).toBe(401);

  expect((await b.req("/dashboard/api/auth/accounts", { username: "Ann!", password: "long enough pass" })).status).toBe(400);
  expect((await b.req("/dashboard/api/auth/accounts", { username: "ann", password: "short" })).body.error.message).toContain("12");
  const made = await b.req("/dashboard/api/auth/accounts", { username: "ann", password: "correct horse battery" });
  expect(made.status).toBe(200);
  expect((await b.req("/dashboard/api/auth/me")).body).toMatchObject({ user: "ann", root: false, password: true, passkeys: [], accounts: 1 });
  expect((await b.req("/dashboard/api/auth/accounts", { username: "ann" })).status).toBe(409);
  // The stored hash is PBKDF2, never the password.
  const a = await t.w.platform.db.accounts.get("ann");
  expect(a?.password).toMatch(/^pbkdf2-sha256\$100000\$/);
  expect(a?.password).not.toContain("correct");
});

test("password sign-in, sign out, sign out everywhere; too many tries are rate limited", async () => {
  const t = await setup();
  const root = browser(t);
  root.setCookie(t.cookie);
  await root.req("/dashboard/api/auth/accounts", { username: "bob", password: "correct horse battery" });

  const b = browser(t);
  expect((await b.req("/dashboard/api/auth/password", { username: "bob", password: "wrong password!!" })).status).toBe(401);
  expect((await b.req("/dashboard/api/auth/password", { username: "nobody", password: "correct horse battery" })).body.error.message).toBe("wrong username or password");
  expect((await b.req("/dashboard/api/auth/password", { username: "BOB", password: "correct horse battery" })).status).toBe(200);
  expect((await b.req("/dashboard/api/auth/me")).body.user).toBe("bob");
  const other = browser(t);
  await other.req("/dashboard/api/auth/password", { username: "bob", password: "correct horse battery" });

  await b.req("/dashboard/api/auth/logout", {});
  expect((await b.req("/dashboard/api/auth/me")).body).toBe(null);
  expect((await other.req("/dashboard/api/auth/me")).body.user).toBe("bob");
  await other.req("/dashboard/api/auth/signout", {});
  // Every session of bob's is gone, though the cookie would still verify.
  const stale = browser(t);
  await stale.req("/dashboard/api/auth/password", { username: "bob", password: "correct horse battery" });
  const c = stale.cookie();
  await stale.req("/dashboard/api/auth/signout", {});
  stale.setCookie(c);
  expect((await stale.req("/dashboard/api/auth/me")).body).toBe(null);

  const r = browser(t);
  // Four of bob's ten tries went above.
  for (let i = 0; i < 6; i++) expect((await r.req("/dashboard/api/auth/password", { username: "bob", password: "wrong password!!" })).status).toBe(401);
  const limited = await r.req("/dashboard/api/auth/password", { username: "bob", password: "correct horse battery" });
  expect(limited.status).toBe(429);
  await t.w.advance(15 * 60_000);
  expect((await r.req("/dashboard/api/auth/password", { username: "bob", password: "correct horse battery" })).status).toBe(200);
});

test("passkeys: register on a signed-in account, sign in with it; wrong origin, replay and a cloned counter are refused", async () => {
  const t = await setup();
  const b = browser(t);
  b.setCookie(t.cookie);
  await b.req("/dashboard/api/auth/accounts", { username: "cy" }); // passkeys only: no password
  const key = await authenticator();

  const reg = (await b.req("/dashboard/api/auth/passkey/options", { mode: "register" })).body;
  expect(reg).toMatchObject({ rpId: "oc.test", user: { id: "cy", name: "cy" }, exclude: [], algorithms: [-7, -257] });
  expect((await b.req("/dashboard/api/auth/me/passkeys", { name: "laptop", credential: await key.create(reg.challenge, { origin: "https://evil.test" }) })).status).toBe(400);
  expect((await b.req("/dashboard/api/auth/me/passkeys", { name: "laptop", credential: await key.create(reg.challenge, { flags: 0x40 }) })).body.error.message).toContain("present");
  const added = await b.req("/dashboard/api/auth/me/passkeys", { name: "laptop", credential: await key.create(reg.challenge) });
  expect(added.status).toBe(201);
  expect(added.body.passkeys).toEqual([{ id: key.id, name: "laptop", createdAt: expect.any(Number), lastUsedAt: null }]);
  // The challenge was used.
  expect((await b.req("/dashboard/api/auth/me/passkeys", { name: "again", credential: await key.create(reg.challenge) })).status).toBe(400);
  // A root session has no account to add one to.
  const root = browser(t);
  root.setCookie(t.cookie);
  expect((await root.req("/dashboard/api/auth/passkey/options", { mode: "register" })).status).toBe(401);

  const s = browser(t);
  const ch = (await s.req("/dashboard/api/auth/passkey/options", { mode: "login" })).body.challenge;
  expect((await s.req("/dashboard/api/auth/passkey", await key.get(ch, { origin: "https://evil.test" }))).status).toBe(401);
  const ok = await s.req("/dashboard/api/auth/passkey", await key.get(ch));
  expect(ok.status).toBe(200);
  expect((await s.req("/dashboard/api/auth/me")).body.user).toBe("cy");
  // Replayed challenge, and a counter that didn't go up (a cloned key).
  expect((await browser(t).req("/dashboard/api/auth/passkey", await key.get(ch))).status).toBe(401);
  const ch2 = (await s.req("/dashboard/api/auth/passkey/options", { mode: "login" })).body.challenge;
  expect((await browser(t).req("/dashboard/api/auth/passkey", await key.get(ch2, { counter: 2 }))).body.error.message).toContain("counter");
  const unknown = await authenticator();
  expect((await browser(t).req("/dashboard/api/auth/passkey", await unknown.get(ch2))).status).toBe(401);

  // Never left without a way in.
  expect((await s.req(`/dashboard/api/auth/me/passkeys/${encodeURIComponent(key.id)}/delete`, {})).status).toBe(409);
  await s.req("/dashboard/api/auth/me/password", { password: "now a long password" });
  expect((await s.req(`/dashboard/api/auth/me/passkeys/${encodeURIComponent(key.id)}/delete`, {})).body.passkeys).toEqual([]);
  expect((await s.req("/dashboard/api/auth/me/password", { password: null })).status).toBe(409);
});

test("invites: a one-time link makes a new account, signed in", async () => {
  const t = await setup();
  const b = browser(t);
  b.setCookie(t.cookie);
  const { url } = (await b.req("/dashboard/api/auth/invites", {})).body;
  expect(url).toStartWith(`${OC}/dashboard#invite=`);
  const tok = decodeURIComponent(url.split("#invite=")[1]);
  const j = browser(t);
  expect((await j.req("/dashboard/api/auth/join", { token: tok, username: "dee", password: "short" })).status).toBe(400);
  expect((await j.req("/dashboard/api/auth/join", { token: tok, username: "dee", password: "a long password!" })).status).toBe(200);
  expect((await j.req("/dashboard/api/auth/me")).body.user).toBe("dee");
  expect((await browser(t).req("/dashboard/api/auth/join", { token: tok, username: "eve", password: "a long password!" })).status).toBe(401);
  expect(await t.w.platform.db.accounts.get("eve")).toBe(null);
  // A login token isn't an invite.
  expect((await browser(t).req("/dashboard/api/auth/join", { token: await t.loginToken(), username: "eve" })).status).toBe(401);

  const list = (await j.req("/dashboard/api/auth/accounts")).body;
  expect(list).toEqual([{ username: "dee", createdAt: expect.any(Number), password: true, passkeys: 0 }]);
  // Deleting yourself signs you out.
  const del = await j.req("/dashboard/api/auth/accounts/dee/delete", {});
  expect(del.set).toContain("Max-Age=0");
  expect((await j.req("/dashboard/api/auth/me")).body).toBe(null);
});

test("a session manages keys through /admin, as the CLI does", async () => {
  const t = await setup();
  const b = browser(t);
  b.setCookie(t.cookie);
  const made = await b.req("/admin/keys", { name: "web" });
  expect(made.status).toBe(201);
  expect(made.body.key).toStartWith("ock_");
  expect((await b.req("/admin/keys")).body.map((k: { name: string }) => k.name).sort()).toEqual(["test", "test", "web"]);
  // Not from another origin.
  expect((await b.req("/admin/keys", { name: "x" }, { origin: "https://evil.test" })).status).toBe(401);
});

test("derToRaw: what authenticators send, r and s each padded to 32 bytes", () => {
  const raw = new Uint8Array(64).map((_, i) => (i === 0 || i === 32 ? 0x80 : i % 7));
  expect([...derToRaw(der(raw))]).toEqual([...raw]);
  const small = new Uint8Array(64).map((_, i) => (i < 3 || (i >= 32 && i < 34) ? 0 : 5));
  expect([...derToRaw(der(small))]).toEqual([...small]);
});
