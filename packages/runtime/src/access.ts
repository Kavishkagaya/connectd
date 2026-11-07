import { safeEqual } from "@kavishkagaya/connectd-connections";
import { base64url, decrypt, encrypt, type Json, type KeyKind, type KeyRow, type Keys, type Management, type Platform, randomId, sign, verify } from "@kavishkagaya/connectd-kernel";

/**
 * Who may call a deployment (#86). Two kinds of credential, both in the management database and
 * managed through `/admin` (the CLI and the dashboard):
 *
 * - API keys, `ock_<id>_<secret>`: the app's Bearer credential. Only the secret's SHA-256 is stored.
 * - Events signing secrets, `whsec_<base64>`: events are signed with every live one (Standard
 *   Webhooks allows several signatures), so a roll with a grace period never drops a delivery.
 *
 * Both roll (a new secret; the old one valid for a grace period) and revoke. Key rows are cached per
 * isolate for KEY_CACHE_MS: a revoke or roll elsewhere takes up to that long to reach every isolate.
 *
 * And signed, short-lived tokens under the deployment's admin key (`CONNECTD_ADMIN_KEY`, derived by
 * the CLI from the project's root key, which never leaves the CLI): `admin` (a CLI request), `login`
 * (a dashboard sign-in link), `invite`, `session` (the dashboard's cookie), `webauthn` (a challenge).
 */

/** How long an isolate trusts a cached key row. */
export const KEY_CACHE_MS = 30_000;
/** `lastUsedAt` is written at most this often per key. */
const TOUCH_MS = 60_000;

const PREFIX = "ock_";
const ID = /^[0-9a-f]{12}$/;
const hex = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");
const digest = async (s: string) => base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
const whsec = () => `whsec_${btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))}`;

/** A key as `/admin/keys` shows it: never its value. */
export type KeyInfo = Omit<KeyRow, "value" | "previous"> & {
  /** What identifies it at a glance: `ock_<id>` (an API key's start) or `whsec_…<id>`. */
  prefix: string;
  status: "active" | "rolling" | "revoked";
};

export const keyInfo = (r: KeyRow, now: number): KeyInfo => {
  const { value: _v, previous: _p, ...rest } = r;
  return {
    ...rest,
    prefix: r.kind === "api" ? `${PREFIX}${r.id}` : `whsec_…${r.id}`,
    status: r.revokedAt !== null ? "revoked" : r.previous !== null && (r.previousUntil ?? 0) > now ? "rolling" : "active",
  };
};

/** A fresh secret for `kind`: what the caller is shown once, and what's stored. */
async function secret(kind: KeyKind, id: string, keys: Keys): Promise<{ shown: string; value: string }> {
  if (kind === "events") {
    const s = whsec();
    return { shown: s, value: await encrypt(s, keys) };
  }
  const s = randomId(32);
  return { shown: `${PREFIX}${id}_${s}`, value: await digest(s) };
}

const NAME = /^[\w .:@-]{1,64}$/;
export const badName = (name: unknown) => (typeof name === "string" && NAME.test(name) ? null : "a name: 1 to 64 letters, digits, spaces and _ . : @ -");

/** Make a key. `key` is its secret: shown once, never stored. */
export async function createKey(p: Platform, keys: Keys, kind: KeyKind, name: string): Promise<{ key: string; info: KeyInfo }> {
  const now = p.now();
  for (;;) {
    const id = hex(6);
    const { shown, value } = await secret(kind, id, keys);
    const row: KeyRow = { id, kind, name, value, previous: null, previousUntil: null, createdAt: now, rolledAt: null, revokedAt: null, lastUsedAt: null };
    // A taken id (one in 2^48): draw again.
    if (await p.db.keys.create(row)) return { key: shown, info: keyInfo(row, now) };
  }
}

/**
 * Store a key whose secret is already known: an API key `ock_<12 hex>_<secret>`, or an events secret
 * `whsec_<base64>`. Tests seed one this way.
 */
export async function importKey(p: Platform, keys: Keys, kind: KeyKind, name: string, key: string): Promise<KeyInfo> {
  const now = p.now();
  let id: string;
  let value: string;
  if (kind === "api") {
    id = key.slice(PREFIX.length, PREFIX.length + 12);
    if (!key.startsWith(PREFIX) || !ID.test(id) || key[PREFIX.length + 12] !== "_" || key.length < PREFIX.length + 14) throw new Error("an API key is ock_<12 hex>_<secret>");
    value = await digest(key.slice(PREFIX.length + 13));
  } else {
    if (!key.startsWith("whsec_")) throw new Error("an events secret is whsec_<base64>");
    id = hex(6);
    value = await encrypt(key, keys);
  }
  const row: KeyRow = { id, kind, name, value, previous: null, previousUntil: null, createdAt: now, rolledAt: null, revokedAt: null, lastUsedAt: null };
  if (!(await p.db.keys.create(row))) throw new Error(`key ${id} exists`);
  forget(p.db, id);
  return keyInfo(row, now);
}

/** A new secret for a live key; the old one keeps working for `graceMs` (0: it stops now). Null when there's no live key `id`. */
export async function rollKey(p: Platform, keys: Keys, id: string, graceMs: number): Promise<{ key: string; info: KeyInfo } | null> {
  const now = p.now();
  const cur = await p.db.keys.get(id);
  if (!cur || cur.revokedAt !== null) return null;
  const { shown, value } = await secret(cur.kind, id, keys);
  const row = await p.db.keys.roll(id, value, now + Math.max(0, graceMs), now);
  forget(p.db, id);
  return row && { key: shown, info: keyInfo(row, now) };
}

export async function revokeKey(p: Platform, id: string): Promise<KeyInfo | null> {
  const row = await p.db.keys.revoke(id, p.now());
  forget(p.db, id);
  return row && keyInfo(row, p.now());
}

// ---- The per-isolate cache: rows by id, and the events secrets ------------------------------------

type Cached = { row: KeyRow | null; until: number };
const rows = new WeakMap<Management, Map<string, Cached>>();
const signing = new WeakMap<Management, { secrets: Promise<string[]>; until: number }>();

function forget(db: Management, id: string) {
  rows.get(db)?.delete(id);
  signing.delete(db);
}

async function row(p: Platform, id: string): Promise<KeyRow | null> {
  let m = rows.get(p.db);
  if (!m) rows.set(p.db, (m = new Map()));
  const c = m.get(id);
  if (c && c.until > p.now()) return c.row;
  const r = await p.db.keys.get(id);
  m.set(id, { row: r, until: p.now() + KEY_CACHE_MS });
  return r;
}

/**
 * The API key a request carries (`Authorization: Bearer ock_<id>_<secret>`), or null. A rolled key's
 * old secret counts until its grace period ends.
 */
export async function apiKey(p: Platform, req: Request): Promise<KeyRow | null> {
  const m = /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "");
  const s = m?.[1] ?? "";
  const id = s.slice(PREFIX.length, PREFIX.length + 12);
  if (!s.startsWith(PREFIX) || !ID.test(id) || s[PREFIX.length + 12] !== "_") return null;
  const r = await row(p, id);
  if (!r || r.kind !== "api" || r.revokedAt !== null) return null;
  const d = await digest(s.slice(PREFIX.length + 13));
  const now = p.now();
  const ok = (await safeEqual(d, r.value)) || (r.previous !== null && (r.previousUntil ?? 0) > now && (await safeEqual(d, r.previous)));
  if (!ok) return null;
  if (r.lastUsedAt === null || now - r.lastUsedAt > TOUCH_MS) {
    r.lastUsedAt = now;
    p.defer(p.db.keys.used(id, now));
  }
  return r;
}

/** Every live events signing secret (and a rolled one's old secret in its grace period), newest first. */
export function eventSecrets(p: Platform, keys: Keys): Promise<string[]> {
  const c = signing.get(p.db);
  if (c && c.until > p.now()) return c.secrets;
  const secrets = (async () => {
    const now = p.now();
    const live = (await p.db.keys.list()).filter((r) => r.kind === "events" && r.revokedAt === null).reverse();
    const sealed = live.flatMap((r) => [r.value, ...(r.previous !== null && (r.previousUntil ?? 0) > now ? [r.previous] : [])]);
    return Promise.all(sealed.map((v) => decrypt(v, keys)));
  })();
  // A failed read isn't cached.
  secrets.catch(() => signing.delete(p.db));
  signing.set(p.db, { secrets, until: p.now() + KEY_CACHE_MS });
  return secrets;
}

// ---- Signed tokens ---------------------------------------------------------------------------------

export type Purpose = "admin" | "login" | "invite" | "session" | "webauthn";
export type TokenClaims = { p: Purpose; exp: number; n: string } & Record<string, Json>;

/** A token for `purpose`, valid `ttlMs` from `now`, under the admin key. `n` is a fresh nonce (for one-time use). */
export const token = (key: CryptoKey, purpose: Purpose, now: number, ttlMs: number, extra: Record<string, Json> = {}) =>
  sign(JSON.stringify({ ...extra, p: purpose, exp: now + ttlMs, n: randomId(12) }), key);

/** The claims of a valid, unexpired token for `purpose`, or null. `maxTtlMs`: refuse one that claims to live longer. */
export async function readToken(key: CryptoKey, purpose: Purpose, s: string, now: number, maxTtlMs: number): Promise<TokenClaims | null> {
  const payload = await verify(s, key);
  if (payload === null) return null;
  try {
    const c = JSON.parse(payload) as TokenClaims;
    if (c.p !== purpose || typeof c.exp !== "number" || typeof c.n !== "string" || c.exp <= now || c.exp > now + maxTtlMs) return null;
    return c;
  } catch {
    return null;
  }
}

/** Use a token once: false when its nonce was used before. */
export const once = (p: Platform, c: TokenClaims) => p.db.nonces.claim(c.n, c.exp, p.now());

/** How long a CLI request's admin token may live. */
export const ADMIN_TTL_MS = 60_000;

/** A CLI request (`Authorization: Admin <token>`): a valid admin token, each used once. */
export async function adminRequest(p: Platform, key: CryptoKey, req: Request): Promise<boolean> {
  const m = /^Admin (\S+)$/.exec(req.headers.get("authorization") ?? "");
  if (!m) return false;
  const c = await readToken(key, "admin", m[1] as string, p.now(), ADMIN_TTL_MS);
  return !!c && (await once(p, c));
}

// ---- Dashboard sessions ----------------------------------------------------------------------------

/** The dashboard's session cookie. */
export const SESSION_COOKIE = "connectd_session";
/** A session from a CLI link (no account yet, or recovery). */
export const ROOT_SESSION_MS = 3_600_000;
/** A session from an account's sign-in. */
export const SESSION_MS = 12 * 3_600_000;

/** Who a session is: an account, or `null` for a CLI-signed root session. */
export type Session = { user: string | null; exp: number };

const cookie = (header: string, name: string) =>
  header
    .split(";")
    .map((c) => c.trim().split("="))
    .find(([k]) => k === name)?.[1];

/**
 * The dashboard session a request carries, or null. A request that changes something (not GET or
 * HEAD) also needs an `Origin` header of this deployment: the cookie is SameSite=Strict, and this
 * holds even where a browser doesn't enforce that.
 */
export async function session(p: Platform, key: CryptoKey, req: Request): Promise<Session | null> {
  const raw = cookie(req.headers.get("cookie") ?? "", SESSION_COOKIE);
  if (!raw) return null;
  if (req.method !== "GET" && req.method !== "HEAD" && req.headers.get("origin") !== new URL(req.url).origin) return null;
  const c = await readToken(key, "session", decodeURIComponent(raw), p.now(), SESSION_MS);
  if (!c) return null;
  if (c.u === null) return { user: null, exp: c.exp };
  if (typeof c.u !== "string") return null;
  const a = await p.db.accounts.get(c.u);
  // A deleted account, or one signed out everywhere since.
  return a && a.sessions === c.v ? { user: a.username, exp: c.exp } : null;
}

/** The `Set-Cookie` value for a new session (or, with `token` empty, one that clears it). */
export function sessionCookie(req: Request, value: string, maxAgeMs: number) {
  // Secure everywhere but plain-http localhost (dev), where a browser wouldn't send a Secure cookie back.
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure}`;
}

/** A session token for an account (or the root, `null`). */
export async function newSession(p: Platform, key: CryptoKey, user: string | null): Promise<{ token: string; ttlMs: number } | null> {
  const now = p.now();
  if (user === null) return { token: await token(key, "session", now, ROOT_SESSION_MS, { u: null }), ttlMs: ROOT_SESSION_MS };
  const a = await p.db.accounts.get(user);
  return a && { token: await token(key, "session", now, SESSION_MS, { u: a.username, v: a.sessions }), ttlMs: SESSION_MS };
}
