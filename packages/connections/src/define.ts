import {
  type Credential,
  connection,
  type Driver,
  type Json,
  type Keys,
  type Limit,
  NotActive,
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
  /** The input fields `start` asks the user for (`apiKey`); a frontend renders them as a form (#29). */
  fields?: string[];
};

export type Definition<C, M extends Json> = {
  id: string;
  auth: Auth<C>;
  /** Who the credential belongs to (account id, team, instance URL). Runs before activation, so a throw rejects the credential. */
  metadata?(ctx: Ctx<C>, cred: Credential): Promise<M>;
  /** External ids in the metadata (Slack `teamId`), indexed for lookup (#26) and webhook routing (#25). */
  external?(metadata: M): Record<string, string>;
  /** Limits per connection and per app; the proxy (#23) acquires them and feeds `observe` back. */
  rate?: { connection?: Limit; app?: Limit; observe?(res: Response, now: number): Observed };
  /** Where the proxy (#23) sends `/proxy/:def/:id/<path>`, and how the credential goes on the request. */
  // ponytail: one fixed base URL; make it a function of the credential when a provider needs a per-connection host (Salesforce instance_url).
  proxy?: { baseUrl: string; inject?: Inject };
  /** Incoming provider webhooks (#25): how to check and read them, and optionally how to register one per connection. */
  webhooks?: Webhooks<C>;
};

/** A webhook as the provider sent it. `body` is raw: verify before parsing. */
export type Webhook = { headers: Headers; body: string };

/**
 * A verified webhook: a handshake answered as is (Slack `url_verification`, GitHub `ping`), or an
 * event to deliver. `delivery` is the provider's id for it (receivers dedupe on it); `external`
 * names the account it's for, which routes app-level webhooks through the index (#26).
 */
export type Incoming = { reply: Json } | { topic: string; delivery?: string; payload: Json; external?: { key: string; value: string } };

export type Webhooks<C> = {
  /**
   * True if the provider sent it. `secret` is this connection's own webhook secret on
   * `/webhooks/:def/:id` (the one `register` handed the provider), null on the app-level route;
   * app-wide secrets (Slack's signing secret) come from config.
   */
  verify(ctx: Pick<Ctx<C>, "config" | "now">, req: Webhook, secret: string | null): Promise<boolean>;
  /** Read a verified webhook. A throw is a 400. */
  parse(req: Webhook): Incoming;
  /**
   * Create the provider-side subscription for an active connection, pointed at `endpoint`.
   * Returns what `unregister` needs, and when it lapses (Google channels) so it gets renewed. Null: nothing to register.
   */
  register?(ctx: Ctx<C>, cred: Credential, endpoint: { url: string; secret: string }): Promise<{ hook: Json; expiresAt?: number } | null>;
  /** Remove what `register` created. Best effort: runs before revoke, and after a renewal for the old one. */
  unregister?(ctx: Ctx<C>, cred: Credential, hook: Json): Promise<void>;
};

const utf8 = new TextEncoder();

/** Hex HMAC-SHA256 of `message` under `secret` (GitHub `sha256=`, Slack `v0=`). */
export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", utf8.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8.encode(message)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Compare a received signature or token with the expected one. Compares digests, so timing leaks nothing about `expected`. */
export async function safeEqual(got: string, expected: string): Promise<boolean> {
  const h = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", utf8.encode(s)));
  const [a, b] = await Promise.all([h(got), h(expected)]);
  return a.every((x, i) => x === b[i]);
}

/**
 * How a proxied request carries the credential: a header (default `Authorization: Bearer <token>`),
 * a query parameter, or a hook for anything else. The value is the access token, or a static
 * credential's `field` (default: its first field).
 */
export type Inject =
  | { header: string; prefix?: string; field?: string }
  | { query: string; field?: string }
  | ((url: URL, headers: Headers, cred: Credential) => void);

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

/** Bad input from the caller (missing fields, unknown state), as opposed to a provider or definition failure. */
export class InputError extends Error {}

export const defineConnection = <C, M extends Json = null>(def: Definition<C, M>) => def;

export type Handshake = { data: Json; extra?: Json };

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

  /** Take the handshake a callback's `state` names, at most once: the start step's data and `connect`'s `extra`. */
  async function handshake(params: Record<string, string>): Promise<Handshake> {
    const hs = (await conn.handshake.take(params.state ?? "")) as Handshake | null;
    if (!hs) throw new InputError("unknown or expired state");
    return hs;
  }

  async function finish(cred: Credential) {
    const meta = def.metadata ? await def.metadata(ctx, cred) : null;
    await conn.activate(cred);
    // ponytail: metadata sits next to the record, not in its cas; it's derived, re-auth rewrites it.
    if (def.metadata) await d.store.put("meta", meta);
  }

  return {
    conn,
    /** What definition hooks see; extensions call webhook hooks with it. */
    ctx,

    /**
     * Begin an authorization (first connect or re-auth). The URL to send the user to, or null if it
     * finished inline. `extra` rides in the handshake and comes back from `handshake()` (where a
     * frontend session returns to, #29).
     */
    async connect(input: Record<string, string> = {}, extra?: Json): Promise<string | null> {
      const s = await conn.read();
      if (s?.state === "revoked") throw new NotActive("revoked", s.reason);
      const step = await def.auth.start(ctx, input);
      if ("credential" in step) {
        await finish(step.credential);
        return null;
      }
      // Lost cas = someone else created the record meanwhile; fine.
      if (!s) await conn.write(null, "pending", null);
      return step.redirect(await conn.handshake.open({ data: step.data, ...(extra === undefined ? {} : { extra }) }));
    },

    handshake,

    /** The provider redirected back. `params` is the callback query, `state` included; `hs` if already taken. */
    async callback(params: Record<string, string>, hs?: Handshake) {
      const h = hs ?? (await handshake(params));
      if (!def.auth.callback) throw new Error(`${def.id}: no callback step`);
      await finish(await def.auth.callback(ctx, params, h.data));
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
