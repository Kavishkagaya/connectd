import {
  type Credential,
  connection,
  type Driver,
  type Json,
  type Keys,
  type Limit,
  type OAuth2,
  type Observed,
  type TokenResponse,
} from "@openconnect/kernel";

/**
 * A connection definition: how to authorize against one provider, plus its quirks. Plain data and
 * functions over kernel primitives; the same definition runs in dev, self-hosted and managed.
 * `C` is the connector config (client id/secret, set per app), `M` the per-connection metadata.
 */

export type Ctx<C> = { config: C; fetch: typeof fetch; redirectUri: string; now(): number };

/** First step of an authorization: send the user somewhere (data comes back at the callback), or done already. */
export type Start = { redirect: (state: string) => string; data: Json } | { credential: Credential };

/** The flow as steps. Helpers (`oauth2`, `apiKey`) build these; a custom flow writes them directly. */
export type Auth<C> = {
  start(ctx: Ctx<C>, input: Record<string, string>): Promise<Start>;
  callback?(ctx: Ctx<C>, params: Record<string, string>, data: Json): Promise<Credential>;
  /** Throw `OAuthError("invalid_grant")` when the refresh token is dead; anything else is retried. */
  refresh?(ctx: Ctx<C>, cred: OAuth2): Promise<TokenResponse>;
  /** Revoke at the provider. Best effort: the connection is revoked locally either way. */
  revoke?(ctx: Ctx<C>, cred: Credential): Promise<void>;
};

export type Definition<C, M extends Json> = {
  id: string;
  auth: Auth<C>;
  /** Who the credential belongs to (account id, team, instance URL). Runs before activation, so a throw rejects the credential. */
  metadata?(ctx: Ctx<C>, cred: Credential): Promise<M>;
  /** Limits per connection and per app; the proxy (#23) acquires them and feeds `observe` back. */
  rate?: { connection?: Limit; app?: Limit; observe?(res: Response, now: number): Observed };
};

/** `Retry-After` (seconds or HTTP date), plus remaining/reset headers when named (reset in epoch seconds). */
export function rateHeaders(res: Response, now: number, names?: { remaining: string; reset: string }): Observed {
  const o: Observed = {};
  const ra = res.headers.get("retry-after");
  if (ra !== null) {
    const ms = /^\d+$/.test(ra) ? Number(ra) * 1000 : Date.parse(ra) - now;
    if (ms >= 0) o.retryAfterMs = ms;
  }
  const remaining = names && res.headers.get(names.remaining);
  const reset = names && res.headers.get(names.reset);
  if (remaining) o.remaining = Number(remaining);
  if (reset) o.resetAt = Number(reset) * 1000;
  return o;
}

export const defineConnection = <C, M extends Json = null>(def: Definition<C, M>) => def;

export type BindOptions<C> = Omit<Ctx<C>, "now"> & { keys: Keys; stateKey: CryptoKey };

/** Run a definition on one connection instance. Create once per Program instance, like `connection()`. */
export function bind<C, M extends Json>(def: Definition<C, M>, d: Driver, instance: string, opts: BindOptions<C>) {
  const ctx: Ctx<C> = { config: opts.config, fetch: opts.fetch, redirectUri: opts.redirectUri, now: () => d.now() };
  const { refresh, revoke } = def.auth;
  const conn = connection(d, instance, {
    keys: opts.keys,
    stateKey: opts.stateKey,
    ...(refresh ? { refresh: (c: OAuth2) => refresh(ctx, c) } : {}),
  });

  async function finish(cred: Credential) {
    const meta = def.metadata ? await def.metadata(ctx, cred) : null;
    await conn.activate(cred);
    // ponytail: metadata sits next to the record, not in its cas; it's derived, re-auth rewrites it.
    if (def.metadata) await d.store.put("meta", meta);
  }

  return {
    conn,

    /** Begin an authorization (first connect or re-auth). The URL to send the user to, or null if it finished inline. */
    async connect(input: Record<string, string> = {}): Promise<string | null> {
      const s = await conn.read();
      if (s?.state === "revoked") throw new Error("connection is revoked; reconnect with a new one");
      const step = await def.auth.start(ctx, input);
      if ("credential" in step) {
        await finish(step.credential);
        return null;
      }
      // Lost cas = someone else created the record meanwhile; fine.
      if (!s) await conn.write(null, "pending", null);
      return step.redirect(await conn.handshake.open({ data: step.data }));
    },

    /** The provider redirected back. `params` is the callback query, `state` included. */
    async callback(params: Record<string, string>) {
      const hs = (await conn.handshake.take(params.state ?? "")) as { data: Json } | null;
      if (!hs) throw new Error("unknown or expired state");
      if (!def.auth.callback) throw new Error(`${def.id}: no callback step`);
      await finish(await def.auth.callback(ctx, params, hs.data));
    },

    token: conn.token,

    metadata: async () => ((await d.store.get("meta"))?.value ?? null) as M | null,

    async revoke(reason?: string) {
      const s = await conn.read();
      if (s?.credential && revoke) await revoke(ctx, s.credential).catch((e) => console.error("provider revoke failed", instance, e));
      return conn.revoke(reason);
    },

    onTimer: conn.onTimer,
  };
}
