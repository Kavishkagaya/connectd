import { type Json, type Platform, RATE } from "@kavishkagaya/connectd-kernel";
import { type Api, Fail, newSession, once, readToken, type Session, session, sessionCookie, token } from "@kavishkagaya/connectd-runtime";
import { check, hash, weak } from "./password.ts";
import { ALGORITHMS, type Assertion, type Attestation, assertion, registration, WebAuthnError } from "./webauthn.ts";

/**
 * Signing in to the dashboard (#86), under `/dashboard/api/auth/`. The first way in is a link the CLI
 * signs with the admin key (`connectd dashboard`): it opens a root session, and the dashboard then
 * asks for an account, so the next sign-in needs no CLI. Accounts sign in with a passkey, a password,
 * or both; any account can invite others (a one-time link) and manage keys and accounts.
 *
 *   GET  me                       who's signed in, and their passkeys; null when nobody is
 *   POST login                    { token }: a CLI link → a root session
 *   POST password                 { username, password }
 *   POST passkey/options          { mode: "login" | "register" }: a challenge
 *   POST passkey                  a passkey sign-in (the browser's assertion)
 *   POST logout · POST signout    this session · every session of this account
 *   POST join                     { token, username, password? }: an invite → a new account
 *   GET  accounts · POST accounts { username, password? } · POST accounts/:name/delete
 *   POST invites                  → { url }: a one-time link, for 72 hours
 *   POST me/password              { password | null }: set or remove your own
 *   POST me/passkeys              { credential, name }: add one · POST me/passkeys/:id/delete
 */

/** How long a CLI sign-in link may claim to live (the CLI makes 5-minute ones). */
const LOGIN_MAX_MS = 10 * 60_000;
const INVITE_MS = 72 * 3_600_000;
const CHALLENGE_MS = 5 * 60_000;
/** Password and passkey sign-ins per username (and across all), per 15 minutes. */
const ATTEMPTS = { count: 10, periodMs: 15 * 60_000 };
const ALL_ATTEMPTS = { count: 200, periodMs: 15 * 60_000 };

const USERNAME = /^[a-z0-9][a-z0-9._-]{1,31}$/;
const badUsername = (u: unknown) => (typeof u === "string" && USERNAME.test(u) ? null : "a username: 2 to 32 lowercase letters, digits and . _ - (starting with a letter or digit)");

export type PasskeyInfo = { id: string; name: string; createdAt: number; lastUsedAt: number | null };
export type Me = { user: string | null; root: boolean; password: boolean; passkeys: PasskeyInfo[]; accounts: number; expiresAt: number };
export type AccountInfo = { username: string; createdAt: number; password: boolean; passkeys: number };

const json = (v: unknown, init: ResponseInit = {}) => Response.json(v, { ...init, headers: { "cache-control": "no-store", ...init.headers } });

async function body(req: Request): Promise<Record<string, Json>> {
  try {
    const v = (await req.json()) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, Json>;
  } catch {}
  throw new Fail("bad_request", 400, "body is not a JSON object");
}

/** The origin a ceremony runs on, and its WebAuthn RP id: this request's own (dev's localhost, or the deployment's host). */
const here = (req: Request) => {
  const u = new URL(req.url);
  return { origin: u.origin, rpId: u.hostname };
};

/** Signed in as `user` (null: root): the session cookie, and who it is. */
async function signIn(req: Request, api: Api, user: string | null, extra: Record<string, unknown> = {}) {
  const s = await newSession(api.platform, api.settings.admin, user);
  if (!s) throw new Fail("not_found", 404, `no account ${user}`);
  return json({ ok: true, ...extra }, { headers: { "set-cookie": sessionCookie(req, s.token, s.ttlMs) } });
}

const signedOut = (req: Request) => json({ ok: true }, { headers: { "set-cookie": sessionCookie(req, "", 0) } });

/** One more attempt for `username`, or 429. */
async function attempt(p: Platform, username: string) {
  for (const [atom, limit] of [[`dashboard.login:${username}`, ATTEMPTS], ["dashboard.login", ALL_ATTEMPTS]] as const) {
    const v = (await p.atoms.call(atom, RATE, { op: "acquire", name: "login", limit })) as { ok: boolean; retryAfterMs?: number };
    if (!v.ok) throw new Fail("rate_limited", 429, `too many sign-in attempts; try again in ${Math.ceil((v.retryAfterMs ?? 0) / 60_000)} min`);
  }
}

async function me(api: Api, s: Session): Promise<Me> {
  const db = api.platform.db;
  const accounts = (await db.accounts.list()).length;
  if (s.user === null) return { user: null, root: true, password: false, passkeys: [], accounts, expiresAt: s.exp };
  const a = await db.accounts.get(s.user);
  const keys = await db.passkeys.list(s.user);
  return { user: s.user, root: false, password: !!a?.password, passkeys: keys.map(({ id, name, createdAt, lastUsedAt }) => ({ id, name, createdAt, lastUsedAt })), accounts, expiresAt: s.exp };
}

async function create(api: Api, b: Record<string, Json>): Promise<string> {
  const bad = badUsername(b.username);
  if (bad) throw new Fail("bad_request", 400, bad);
  const pw = b.password ?? null;
  if (pw !== null) {
    const w = weak(pw);
    if (w) throw new Fail("bad_request", 400, `password: ${w}`);
  }
  const username = b.username as string;
  const ok = await api.platform.db.accounts.create({ username, password: pw === null ? null : await hash(pw as string), sessions: 0, createdAt: api.platform.now() });
  if (!ok) throw new Fail("conflict", 409, `${username} is taken`);
  return username;
}

/** `/dashboard/api/auth/...`. `path`: what follows `auth`. */
export async function auth(req: Request, api: Api, path: string[]): Promise<Response> {
  const p = api.platform;
  const db = p.db;
  const key = api.settings.admin;
  const [what, id, op, ...more] = path;
  const post = req.method === "POST";
  // A POST without a session must still come from this origin: no other site signs anyone in.
  if (post && req.headers.get("origin") !== new URL(req.url).origin) throw new Fail("forbidden", 403, "cross-origin request");

  // ---- Without a session: the ways in.
  if (post && what === "login" && !id) {
    const c = await readToken(key, "login", String((await body(req)).token ?? ""), p.now(), LOGIN_MAX_MS);
    if (!c || !(await once(p, c))) throw new Fail("unauthorized", 401, "this sign-in link is used or expired: run connectd dashboard again");
    return signIn(req, api, null);
  }
  if (post && what === "password" && !id) {
    const b = await body(req);
    const username = typeof b.username === "string" ? b.username.toLowerCase() : "";
    await attempt(p, username);
    const a = USERNAME.test(username) ? await db.accounts.get(username) : null;
    if (!a?.password || typeof b.password !== "string" || !(await check(b.password, a.password))) throw new Fail("unauthorized", 401, "wrong username or password");
    return signIn(req, api, a.username);
  }
  if (post && what === "passkey" && id === "options" && !op) {
    const b = await body(req);
    const s = await session(p, key, req);
    const { rpId } = here(req);
    if (b.mode === "register") {
      if (!s?.user) throw new Fail("unauthorized", 401, "sign in to an account to add a passkey");
      const keys = await db.passkeys.list(s.user);
      return json({ challenge: await token(key, "webauthn", p.now(), CHALLENGE_MS, { m: "register", u: s.user }), rpId, user: { id: s.user, name: s.user }, exclude: keys.map((k) => k.id), algorithms: ALGORITHMS });
    }
    if (b.mode === "login") return json({ challenge: await token(key, "webauthn", p.now(), CHALLENGE_MS, { m: "login" }), rpId });
    throw new Fail("bad_request", 400, 'mode: "login" or "register"');
  }
  if (post && what === "passkey" && !id) {
    const a = (await body(req)) as unknown as Assertion;
    const stored = typeof a.id === "string" ? await db.passkeys.get(a.id) : null;
    if (!stored) throw new Fail("unauthorized", 401, "this passkey isn't registered here");
    await attempt(p, stored.username);
    const { origin, rpId } = here(req);
    try {
      const r = await assertion(a, stored, origin, rpId);
      const c = await readToken(key, "webauthn", r.challenge, p.now(), CHALLENGE_MS);
      if (!c || c.m !== "login" || !(await once(p, c))) throw new WebAuthnError("the challenge is used or expired");
      await db.passkeys.used(stored.id, r.counter, p.now());
    } catch (e) {
      if (e instanceof WebAuthnError) throw new Fail("unauthorized", 401, `passkey refused: ${e.message}`);
      throw e;
    }
    return signIn(req, api, stored.username);
  }
  if (post && what === "join" && !id) {
    const b = await body(req);
    const c = await readToken(key, "invite", String(b.token ?? ""), p.now(), INVITE_MS);
    if (!c) throw new Fail("unauthorized", 401, "this invite is used or expired: ask for a new one");
    const username = await create(api, b);
    if (!(await once(p, c))) {
      await db.accounts.delete(username);
      throw new Fail("unauthorized", 401, "this invite is used or expired: ask for a new one");
    }
    return signIn(req, api, username);
  }
  if (post && what === "logout" && !id) return signedOut(req);

  // ---- With a session.
  const s = await session(p, key, req);
  // Asking who's signed in isn't an error when nobody is.
  if (!s && what === "me" && !id && req.method === "GET") return json(null);
  if (!s) throw new Fail("unauthorized", 401, "not signed in");
  if (what === "me" && !id && req.method === "GET") return json(await me(api, s));
  if (post && what === "signout" && !id) {
    if (s.user) await db.accounts.signOut(s.user);
    return signedOut(req);
  }
  if (what === "accounts" && !id) {
    if (req.method === "GET") {
      const list = await db.accounts.list();
      return json(await Promise.all(list.map(async (a): Promise<AccountInfo> => ({ username: a.username, createdAt: a.createdAt, password: !!a.password, passkeys: (await db.passkeys.list(a.username)).length }))));
    }
    if (!post) throw new Fail("method_not_allowed", 405, "GET or POST");
    const username = await create(api, await body(req));
    // From a root session (a CLI link), the new account is yours: signed in as it.
    return s.user === null ? signIn(req, api, username, { username }) : json({ ok: true, username }, { status: 201 });
  }
  if (post && what === "accounts" && id && op === "delete" && !more.length) {
    if (!(await db.accounts.delete(id))) throw new Fail("not_found", 404, `no account ${id}`);
    return id === s.user ? signedOut(req) : json({ ok: true });
  }
  if (post && what === "invites" && !id) {
    const t = await token(key, "invite", p.now(), INVITE_MS, { by: s.user });
    return json({ url: `${new URL(req.url).origin}/dashboard#invite=${t}`, expiresAt: p.now() + INVITE_MS });
  }
  if (what === "me" && post && s.user) {
    if (id === "password" && !op) {
      const pw = (await body(req)).password ?? null;
      if (pw !== null) {
        const w = weak(pw);
        if (w) throw new Fail("bad_request", 400, `password: ${w}`);
      }
      // Never left with no way in: a passkey first, then the password can go.
      if (pw === null && !(await db.passkeys.list(s.user)).length) throw new Fail("conflict", 409, "add a passkey before removing your password");
      await db.accounts.password(s.user, pw === null ? null : await hash(pw as string));
      return json(await me(api, s));
    }
    if (id === "passkeys" && !op) {
      const b = await body(req);
      const cred = b.credential as unknown as Attestation;
      const name = typeof b.name === "string" && b.name.trim() ? b.name.trim().slice(0, 64) : "passkey";
      const { origin, rpId } = here(req);
      try {
        const r = await registration(cred, origin, rpId);
        const c = await readToken(key, "webauthn", r.challenge, p.now(), CHALLENGE_MS);
        if (!c || c.m !== "register" || c.u !== s.user || !(await once(p, c))) throw new WebAuthnError("the challenge is used or expired");
        const added = await db.passkeys.add({ id: cred.id, username: s.user, publicKey: cred.publicKey, alg: cred.alg, counter: r.counter, name, createdAt: p.now(), lastUsedAt: null });
        if (!added) throw new WebAuthnError("this passkey is registered already");
      } catch (e) {
        if (e instanceof WebAuthnError) throw new Fail("bad_request", 400, `passkey refused: ${e.message}`);
        throw e;
      }
      return json(await me(api, s), { status: 201 });
    }
    if (id === "passkeys" && op && more[0] === "delete" && more.length === 1) {
      const k = await db.passkeys.get(op);
      if (!k || k.username !== s.user) throw new Fail("not_found", 404, "no such passkey");
      const a = await db.accounts.get(s.user);
      if (!a?.password && (await db.passkeys.list(s.user)).length === 1) throw new Fail("conflict", 409, "set a password before removing your last passkey");
      await db.passkeys.delete(op);
      return json(await me(api, s));
    }
  }
  throw new Fail("not_found", 404, "no such route");
}
