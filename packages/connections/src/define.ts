import type { Json, Kernel, Limit, Observed } from "@openconnect/kernel";
import { type Credential, lifecycle, NotActive, type OAuth2 } from "./lifecycle.ts";
import type { TokenResponse } from "./oauth.ts";

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
   * `hook` is stored unsealed and shown in the dashboard: ids only, no secrets.
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

export const BEARER: Inject = { header: "authorization", prefix: "Bearer " };

/** Put the credential on a request as `i` says. Throws if a static credential lacks the field. */
export function inject(i: Inject, url: URL, headers: Headers, cred: Credential) {
  if (typeof i === "function") return i(url, headers, cred);
  let v: string | undefined;
  if (cred.kind === "oauth2") v = cred.accessToken;
  else v = i.field ? cred.fields[i.field] : Object.values(cred.fields)[0];
  if (v === undefined) throw new Error(`credential has no field ${i.field ?? "(any)"}`);
  if ("query" in i) url.searchParams.set(i.query, v);
  else headers.set(i.header, (i.prefix ?? "") + v);
}

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

export type BindOptions<C> = Omit<Ctx<C>, "now">;

/**
 * Run a definition on one connection instance, on that instance's kernel (which holds the keys).
 * Create once per Program call, with the kernel: it declares the lifecycle's and its own cells.
 */
export function bind<C, M extends Json>(def: Definition<C, M>, k: Kernel, opts: BindOptions<C>) {
  const ctx: Ctx<C> = { config: opts.config, fetch: opts.fetch, redirectUri: opts.redirectUri, now: () => k.now() };
  const { refresh, revoke } = def.auth;
  const conn = lifecycle(k, refresh ? { refresh: (c: OAuth2) => refresh(ctx, c) } : {});
  /** Who the credential belongs to; `{ m: null }` for a definition without `metadata`. */
  const metaCell = k.cell<{ m: Json }>("meta");

  /** Take the handshake a callback's `state` names, at most once: the start step's data and `connect`'s `extra`. */
  async function handshake(params: Record<string, string>): Promise<Handshake> {
    const hs = (await conn.handshake.take(params.state ?? "")) as Handshake | null;
    if (!hs) throw new InputError("unknown or expired state");
    return hs;
  }

  /** Run the definition's callback step: the credential, not stored yet (a frontend session holds it until the app's page confirms, #29). */
  async function exchange(params: Record<string, string>, hs: Handshake): Promise<Credential> {
    if (!def.auth.callback) throw new Error(`${def.id}: no callback step`);
    return def.auth.callback(ctx, params, hs.data);
  }

  async function finish(cred: Credential) {
    const meta = def.metadata ? await def.metadata(ctx, cred) : null;
    await conn.activate(cred);
    // ponytail: metadata sits next to the record, not in its cas; it's derived, re-auth rewrites it.
    if (def.metadata) await metaCell.put({ m: meta });
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
      if (!s) await conn.pend();
      return step.redirect(await conn.handshake.open({ data: step.data, ...(extra === undefined ? {} : { extra }) }));
    },

    handshake,

    /** The provider redirected back. `params` is the callback query, `state` included; `hs` if already taken. */
    async callback(params: Record<string, string>, hs?: Handshake) {
      await finish(await exchange(params, hs ?? (await handshake(params))));
    },

    exchange,
    /** Check a credential (`metadata`) and activate with it. */
    finish,

    token: conn.token,

    metadata: async () => ((await metaCell.read())?.value.m ?? null) as M | null,
    /** The metadata cell: its version orders index rows (#26). */
    meta: metaCell,

    async revoke(reason?: string) {
      const s = await conn.read();
      if (s?.credential && revoke) await revoke(ctx, s.credential).catch((e) => console.error("provider revoke failed", k.instance, e));
      return conn.revoke(reason);
    },
  };
}
