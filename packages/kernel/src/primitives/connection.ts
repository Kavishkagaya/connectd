import type { Driver, Json } from "../driver.ts";
import { OAuthError, type TokenResponse } from "./oauth.ts";
import { type Backoff, type RetryPayload, retry } from "./schedule.ts";
import { decrypt, encrypt, type Keys, keyVersion, randomId, sign, verify } from "./secrets.ts";

/**
 * One connection's record: lifecycle state, sealed credential and an event outbox, all in one
 * key so one `cas` covers them. Create once per Program instance: single-flight is in memory.
 */

export type State = "pending" | "active" | "reauth_required" | "revoked";

export type OAuth2 = { kind: "oauth2"; accessToken: string; refreshToken?: string; expiresAt?: number; raw: TokenResponse };
/** API keys, basic auth, anything that doesn't refresh. */
export type Static = { kind: "static"; fields: Record<string, string> };
export type Credential = OAuth2 | Static;

/** Emitted on every state change; L3 drains the outbox and delivers (#24). */
export type Event = { seq: number; at: number; from: State | null; to: State; reason?: string };

export type Snapshot = { v: number; state: State; reason?: string; credential: Credential | null; seq: number; events: Event[] };

type Stored = { state: State; reason?: string; credential: string | null; seq: number; events: Event[] };

export type Options = {
  keys: Keys;
  /** HMAC key for handshake `state`. */
  stateKey: CryptoKey;
  /** Exchange a refresh token at the provider; L2 wires this to `refreshGrant`. */
  refresh?: (cred: OAuth2) => Promise<TokenResponse>;
  /** Refresh this long before expiry (default 5 min; at most half the token's lifetime). */
  leadMs?: number;
  /** Backoff for transient refresh failures (default 30s base, 8 attempts, then reauth_required). */
  retry?: Backoff;
};

const LEGAL: Record<State, State[]> = {
  pending: ["pending", "active", "revoked"],
  active: ["active", "reauth_required", "revoked"],
  reauth_required: ["reauth_required", "active", "revoked"],
  revoked: [],
};

export const REFRESH_TIMER = "kernel.refresh";
const MAX_EVENTS = 100;
/** token() refreshes when the access token has less than this left. */
const SKEW_MS = 60_000;

export class IllegalTransition extends Error {}

export class NotActive extends Error {
  constructor(
    readonly state: State | null,
    readonly reason?: string,
  ) {
    super(`connection is ${state ?? "missing"}${reason ? ` (${reason})` : ""}`);
  }
}

type Next = { to: State; credential: Credential | null; reason?: string } | null;

export function connection(d: Driver, instance: string, opts: Options) {
  const inflight = new Map<string, Promise<unknown>>();
  const backoffOpts = { baseMs: 30_000, maxAttempts: 8, ...opts.retry };

  /** Concurrent callers with the same key share one run. */
  function once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let p = inflight.get(key) as Promise<T> | undefined;
    if (!p) {
      p = fn().finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    return p;
  }

  async function read(): Promise<Snapshot | null> {
    const r = await d.store.get("record");
    if (!r) return null;
    const s = r.value as unknown as Stored;
    const credential = s.credential ? (JSON.parse(await decrypt(s.credential, opts.keys)) as Credential) : null;
    const snap: Snapshot = { v: r.v, state: s.state, credential, seq: s.seq, events: s.events, ...(s.reason ? { reason: s.reason } : {}) };
    // Key rotation: re-seal under the current key. A lost cas means someone else wrote, under current.
    if (s.credential && keyVersion(s.credential) !== opts.keys.current && (await write(snap, s.state, credential, s.reason))) return read();
    return snap;
  }

  /**
   * Move to `to` if the record is still at `prev` (null = no record yet).
   * False if someone else wrote first; the caller re-reads and decides (or uses `update`).
   */
  async function write(prev: Snapshot | null, to: State, credential: Credential | null, reason?: string): Promise<boolean> {
    const from = prev?.state ?? null;
    if (from ? !LEGAL[from].includes(to) : to !== "pending" && to !== "active") throw new IllegalTransition(`${from ?? "none"} -> ${to}`);
    if (to === "active" && !credential) throw new IllegalTransition(`active needs a credential`);
    let seq = prev?.seq ?? 0;
    let events = prev?.events ?? [];
    // ponytail: outbox drops the oldest past MAX_EVENTS if nothing drains it; spill to own keys if that bites.
    if (from !== to) events = [...events, { seq: ++seq, at: d.now(), from, to, ...(reason ? { reason } : {}) }].slice(-MAX_EVENTS);
    const value: Stored = {
      state: to,
      credential: credential ? await encrypt(JSON.stringify(credential), opts.keys) : null,
      seq,
      events,
      ...(reason ? { reason } : {}),
    };
    if (!(await d.store.cas("record", prev?.v ?? null, value as unknown as Json))) return false;
    await arm(to, credential);
    return true;
  }

  /** Read, decide, cas, until it lands. `f` returns null to leave the record alone. Returns the record after. */
  async function update(f: (s: Snapshot | null) => Next): Promise<Snapshot | null> {
    for (;;) {
      const s = await read();
      const n = f(s);
      if (!n) return s;
      if (await write(s, n.to, n.credential, n.reason)) return read();
    }
  }

  // ponytail: timer and cas aren't atomic. A crash between them leaves no timer; token() still refreshes on demand.
  async function arm(state: State, c: Credential | null) {
    if (state !== "active" || c?.kind !== "oauth2" || !c.refreshToken || c.expiresAt === undefined || !opts.refresh)
      return d.timer.cancel(REFRESH_TIMER);
    const lead = Math.min(opts.leadMs ?? 300_000, (c.expiresAt - d.now()) / 2);
    // Jitter spreads out connections that were created together.
    const at = c.expiresAt - lead - Math.random() * lead * 0.1;
    await d.timer.set(REFRESH_TIMER, Math.max(d.now(), at), { attempt: 0, data: null });
  }

  const toReauth = (reason: string) =>
    update((s) => (s?.state === "active" ? { to: "reauth_required", credential: null, reason } : null));

  const refresh = (): Promise<Credential> =>
    once("refresh", async () => {
      const s = await read();
      if (s?.state !== "active") throw new NotActive(s?.state ?? null, s?.reason);
      const used = s.credential as Credential;
      if (used.kind !== "oauth2" || !used.refreshToken || !opts.refresh) return used;
      let tok: TokenResponse;
      try {
        tok = await opts.refresh(used);
      } catch (e) {
        // The refresh token is dead; only a new authorization fixes it.
        if (e instanceof OAuthError && e.code === "invalid_grant") {
          await toReauth("invalid_grant");
          throw new NotActive("reauth_required", "invalid_grant");
        }
        throw e;
      }
      const next = credentialFrom(tok, d.now(), used);
      // Keep retrying the write: with rotation, dropping `next` would lose the only valid refresh token.
      // Give up only if a revoke or a re-authorization replaced the credential meanwhile; theirs wins.
      const after = await update((cur) =>
        cur?.state === "active" && cur.credential?.kind === "oauth2" && cur.credential.refreshToken === used.refreshToken
          ? { to: "active", credential: next }
          : null,
      );
      if (after?.state !== "active") throw new NotActive(after?.state ?? null, after?.reason);
      return after.credential as Credential;
    });

  /** A usable credential, refreshed if close to expiry. Throws NotActive otherwise. */
  async function token(): Promise<Credential> {
    const s = await read();
    if (s?.state !== "active") throw new NotActive(s?.state ?? null, s?.reason);
    const c = s.credential as Credential;
    if (c.kind !== "oauth2" || c.expiresAt === undefined || c.expiresAt - d.now() > SKEW_MS) return c;
    const exp = c.expiresAt;
    if (c.refreshToken && opts.refresh)
      // Transient failure while the old token still works: hand out the old token.
      return refresh().catch((e) => {
        if (e instanceof NotActive || exp <= d.now()) throw e;
        return c;
      });
    if (exp > d.now()) return c;
    await toReauth("expired");
    throw new NotActive("reauth_required", "expired");
  }

  return {
    read,
    /** The record's store version (null = no record), without decrypting anything. Changes on every write. */
    version: async (): Promise<number | null> => (await d.store.get("record"))?.v ?? null,
    write,
    update,
    once,
    token,
    refresh,

    /** Store a credential from a finished authorization (first connect or re-auth). */
    activate: (credential: Credential) => update(() => ({ to: "active", credential })),

    /** Terminal. Revoking at the provider is the caller's job (oauth `revoke`), before this. */
    revoke: (reason = "revoked") =>
      update((s) => (s && s.state !== "revoked" ? { to: "revoked", credential: null, reason } : null)),

    /** Route onTimer here. True if it was ours. */
    async onTimer(name: string, payload: Json): Promise<boolean> {
      if (name !== REFRESH_TIMER) return false;
      const { attempt } = payload as unknown as RetryPayload;
      try {
        await refresh();
      } catch (e) {
        if (e instanceof NotActive) return true;
        console.error("refresh failed", instance, attempt, e);
        if (!(await retry(d, REFRESH_TIMER, attempt, null, backoffOpts))) await toReauth("refresh_failed");
      }
      return true;
    },

    events: {
      pending: async () => (await read())?.events ?? [],
      /** Seq of the latest event ever emitted (0 if none). Cheap: no decrypt, so callers can poll it to skip `pending()`. */
      seq: async () => ((await d.store.get("record"))?.value as unknown as Stored | undefined)?.seq ?? 0,
      /** Drop delivered events up to and including `seq`. */
      async ack(seq: number) {
        for (;;) {
          const r = await d.store.get("record");
          const s = r?.value as unknown as Stored | undefined;
          if (!r || !s?.events.some((e) => e.seq <= seq)) return;
          if (await d.store.cas("record", r.v, { ...s, events: s.events.filter((e) => e.seq > seq) } as unknown as Json)) return;
        }
      },
    },

    /** Short-lived flow data (PKCE verifier, nonce), keyed by a signed `state` that routes back here. */
    handshake: {
      async open(data: Json, ttlMs = 600_000): Promise<string> {
        const id = randomId();
        await d.store.put(`hs:${id}`, data, { ttlMs });
        return sign(JSON.stringify([instance, id]), opts.stateKey);
      },
      /** The data for `state`, at most once. Null if forged, expired, used, or for another instance. */
      async take(state: string): Promise<Json | null> {
        const r = await routeState(state, opts.stateKey);
        return r?.instance === instance ? d.store.take(`hs:${r.id}`) : null;
      },
    },
  };
}

/** Which instance a callback's `state` belongs to, without any lookup. Null if forged. */
export async function routeState(state: string, key: CryptoKey): Promise<{ instance: string; id: string } | null> {
  const p = await verify(state, key);
  if (!p) return null;
  const v = JSON.parse(p) as unknown;
  const [instance, id] = Array.isArray(v) ? v : [];
  return typeof instance === "string" && typeof id === "string" ? { instance, id } : null;
}

/** Credential from a token response (throws if it has no access_token); keeps the old refresh token if the provider didn't rotate it. */
export function credentialFrom(tok: TokenResponse, now: number, prev?: Credential | null): OAuth2 {
  if (typeof tok.access_token !== "string") throw new OAuthError("invalid_response", 200, tok);
  const refresh = typeof tok.refresh_token === "string" ? tok.refresh_token : prev?.kind === "oauth2" ? prev.refreshToken : undefined;
  return {
    kind: "oauth2",
    accessToken: tok.access_token as string,
    ...(refresh ? { refreshToken: refresh } : {}),
    ...(typeof tok.expires_in === "number" ? { expiresAt: now + tok.expires_in * 1000 } : {}),
    raw: tok,
  };
}
