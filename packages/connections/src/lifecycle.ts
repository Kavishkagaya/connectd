import type { Backoff, Json, Kernel } from "@kavishkagaya/connectd-kernel";
import { OAuthError, type TokenResponse } from "./oauth.ts";

/**
 * One connection's lifecycle (#7, #8, on the kernel since #53): state, sealed credential and token
 * refresh, in the `record` cell. Every state change emits a `Transition` in the same write (the
 * cell's outbox); the events extension relays it to the user's server. Create once per instance.
 */

export type State = "pending" | "active" | "reauth_required" | "revoked";

/** A token credential. `data` is what a flow keeps per connection to get the next token (GitHub App installation id); it rides along refreshes. */
export type OAuth2 = { kind: "oauth2"; accessToken: string; refreshToken?: string; expiresAt?: number; raw: TokenResponse; data?: Json };
/** API keys, basic auth, anything that doesn't refresh. */
export type Static = { kind: "static"; fields: Record<string, string> };
export type Credential = OAuth2 | Static;

/** Emitted on every state change. Its `seq` is the record outbox's. */
export type Transition = { at: number; from: State | null; to: State; reason?: string };

export type Snapshot = { v: number; state: State; reason?: string; credential: Credential | null };

/** What the record cell holds: the credential sealed, the state readable without the keys. */
type Stored = { state: State; reason?: string; credential: string | null };

export type LifecycleOptions = {
  /** Exchange a refresh token at the provider; `bind` wires the definition's `refresh`. */
  refresh?: (cred: OAuth2) => Promise<TokenResponse>;
  /** `refresh` gets a new token without a refresh token, from what the flow holds (client secret, private key: #56). */
  mints?: boolean;
  /** Refresh this long before expiry (default 5 min; at most half the token's lifetime). */
  leadMs?: number;
  /** Backoff for transient refresh failures (default 30 s base, 8 attempts, then reauth_required). */
  retry?: Backoff;
};

const LEGAL: Record<State, State[]> = {
  pending: ["pending", "active", "revoked"],
  active: ["active", "reauth_required", "revoked"],
  reauth_required: ["reauth_required", "active", "revoked"],
  revoked: [],
};

/** token() refreshes when the access token has less than this left. */
const SKEW_MS = 60_000;
/** A login handshake (OAuth `state`) lives this long. */
const HANDSHAKE_TTL_MS = 600_000;

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

const same = (a: Stored | null, b: Stored | null) =>
  a === b || (!!a && !!b && a.state === b.state && a.credential === b.credential && (a.reason ?? null) === (b.reason ?? null));

export function lifecycle(k: Kernel, opts: LifecycleOptions = {}) {
  const record = k.cell<Stored, Transition>("record");
  const refreshing = k.flight<Credential>();
  const login = k.ticket<Json>("login", { ttlMs: HANDSHAKE_TTL_MS });
  const refreshTimer = k.timer("refresh", {
    async handle() {
      try {
        await refresh();
      } catch (e) {
        // Not active any more (revoked, or reauth after invalid_grant): nothing to retry.
        if (!(e instanceof NotActive)) throw e;
      }
    },
    retry: { baseMs: 30_000, maxAttempts: 8, ...opts.retry },
    giveUp: async () => void (await toReauth("refresh_failed")),
  });

  /** The record as stored and decrypted. Sealed under an old key version: sealed again, then read again. */
  async function load(): Promise<{ snap: Snapshot; raw: Stored } | null> {
    const r = await record.read();
    if (!r) return null;
    const raw = r.value;
    let credential: Credential | null = null;
    if (raw.credential) {
      const u = await k.unseal<Json>(raw.credential);
      credential = u.value as unknown as Credential;
      if (u.stale) {
        const fresh = await k.seal(u.value);
        // A lost update means someone else wrote meanwhile, under the current key too.
        await record.update((cur) => (cur?.credential === raw.credential ? { ...cur, credential: fresh } : null));
        return load();
      }
    }
    return { snap: { v: r.v, state: raw.state, credential, ...(raw.reason ? { reason: raw.reason } : {}) }, raw };
  }

  const read = async () => (await load())?.snap ?? null;

  /**
   * Read, decide, write, until it lands. `f` returns null to leave the record alone; an illegal move
   * throws `IllegalTransition`. The credential is sealed before the write, and a state change emits
   * its `Transition` in the same write. Returns the record after.
   */
  async function update(f: (s: Snapshot | null) => Next): Promise<Snapshot | null> {
    for (;;) {
      const l = await load();
      const n = f(l?.snap ?? null);
      if (!n) return l?.snap ?? null;
      const from = l?.snap.state ?? null;
      if (from ? !LEGAL[from].includes(n.to) : n.to !== "pending" && n.to !== "active") throw new IllegalTransition(`${from ?? "none"} -> ${n.to}`);
      if (n.to === "active" && !n.credential) throw new IllegalTransition("active needs a credential");
      const sealed = n.credential ? await k.seal(n.credential as unknown as Json) : null;
      let landed = false;
      await record.update((cur, emit) => {
        landed = false;
        // Someone wrote since `load`: decide again on what's there now.
        if (!same(cur, l?.raw ?? null)) return null;
        landed = true;
        if (from !== n.to) emit({ at: k.now(), from, to: n.to, ...(n.reason ? { reason: n.reason } : {}) });
        return { state: n.to, credential: sealed, ...(n.reason ? { reason: n.reason } : {}) };
      });
      if (landed) {
        await arm(n.to, n.credential);
        return read();
      }
    }
  }

  /** A refresh can get a new token: a refresh token, or a flow that mints. */
  const renewable = (c: OAuth2) => !!opts.refresh && (!!c.refreshToken || !!opts.mints);
  /** Still the credential a refresh started from: its refresh token, or for minted ones (no refresh token to go by) its access token. */
  const sameCred = (a: OAuth2, b: OAuth2) => (opts.mints ? a.accessToken === b.accessToken : a.refreshToken === b.refreshToken);

  // ponytail: timer and cell writes aren't atomic. A crash between them leaves no timer; token() still refreshes on demand.
  async function arm(state: State, c: Credential | null) {
    if (state !== "active" || c?.kind !== "oauth2" || !renewable(c) || c.expiresAt === undefined) return refreshTimer.cancel();
    const lead = Math.min(opts.leadMs ?? 300_000, (c.expiresAt - k.now()) / 2);
    // Jitter spreads out connections that were created together.
    const at = c.expiresAt - lead - Math.random() * lead * 0.1;
    await refreshTimer.set(Math.max(k.now(), at));
  }

  const toReauth = (reason: string) => update((s) => (s?.state === "active" ? { to: "reauth_required", credential: null, reason } : null));

  const refresh = (): Promise<Credential> =>
    refreshing.run(async () => {
      const s = await read();
      if (s?.state !== "active") throw new NotActive(s?.state ?? null, s?.reason);
      const used = s.credential as Credential;
      if (used.kind !== "oauth2" || !renewable(used) || !opts.refresh) return used;
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
      const next = credentialFrom(tok, k.now(), used);
      // Keep retrying the write: with rotation, dropping `next` would lose the only valid refresh token.
      // Give up only if a revoke or a re-authorization replaced the credential meanwhile; theirs wins.
      const after = await update((cur) =>
        cur?.state === "active" && cur.credential?.kind === "oauth2" && sameCred(cur.credential, used)
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
    if (c.kind !== "oauth2" || c.expiresAt === undefined || c.expiresAt - k.now() > SKEW_MS) return c;
    const exp = c.expiresAt;
    if (renewable(c))
      // Transient failure while the old token still works: hand out the old token.
      return refresh().catch((e) => {
        if (e instanceof NotActive || exp <= k.now()) throw e;
        return c;
      });
    if (exp > k.now()) return c;
    await toReauth("expired");
    throw new NotActive("reauth_required", "expired");
  }

  return {
    /** The cell itself: its version for the index, its outbox for the events queue (`queue.relay`). */
    record,
    read,
    /** The record's version (null = no record), without decrypting anything. Changes on every write. */
    version: async (): Promise<number | null> => (await record.read())?.v ?? null,
    update,
    token,
    refresh,

    /** Create the record as pending, unless it exists. */
    pend: () => update((s) => (s ? null : { to: "pending", credential: null })),

    /** Store a credential from a finished authorization (first connect or re-auth). */
    activate: (credential: Credential) => update(() => ({ to: "active", credential })),

    /** Terminal. Revoking at the provider is the caller's job (oauth `revoke`), before this. */
    revoke: (reason = "revoked") => update((s) => (s && s.state !== "revoked" ? { to: "revoked", credential: null, reason } : null)),

    /** Short-lived flow data (PKCE verifier) behind a signed `state` that routes back here (a kernel ticket). */
    handshake: {
      open: (data: Json) => login.issue(data),
      /** The data for `state`, at most once. Null if forged, expired, used, or another instance's. */
      take: (state: string) => login.redeem(state),
    },
  };
}

export type Lifecycle = ReturnType<typeof lifecycle>;

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
    ...(prev?.kind === "oauth2" && prev.data !== undefined ? { data: prev.data } : {}),
  };
}
