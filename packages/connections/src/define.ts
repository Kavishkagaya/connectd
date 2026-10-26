import type { Json, Kernel, Limit, Observed } from "@kavishkagaya/connectd-kernel";
import type { StandardSchemaV1 } from "./action.ts";
import { type Credential, lifecycle, NotActive, type OAuth2 } from "./lifecycle.ts";
import { OAuthError, type TokenResponse } from "./oauth.ts";

/**
 * A connection definition: how to authorize against one provider, plus its quirks. Plain data and
 * functions over kernel primitives; the same definition runs in dev, self-hosted and managed.
 * `C` is the connector config (client id/secret, set per app), `M` the per-connection metadata.
 */

export type Ctx<C> = { config: C; fetch: typeof fetch; redirectUri: string; now(): number };

/** What a device flow shows the user: go to `verificationUri`, type `userCode` (RFC 8628). */
export type Device = { userCode: string; verificationUri: string; verificationUriComplete?: string; expiresAt: number; intervalMs: number };

/**
 * First step of an authorization: send the user somewhere (data comes back at the callback), done
 * already (API keys, minted tokens), or a device code the user enters elsewhere while `poll` waits.
 */
export type Start = { redirect: (state: string) => string; data: Json } | { credential: Credential } | { device: Device; data: Json };

/** The flow as steps. Helpers (`oauth2`, `apiKey`) build these; a custom flow writes them directly. */
export type Auth<C> = {
  start(ctx: Ctx<C>, input: Record<string, string>): Promise<Start>;
  callback?(ctx: Ctx<C>, params: Record<string, string>, data: Json): Promise<Credential>;
  /** Throw `OAuthError("invalid_grant")` when the refresh token is dead; anything else is retried. */
  refresh?(ctx: Ctx<C>, cred: OAuth2): Promise<TokenResponse>;
  /** Revoke at the provider. Best effort: the connection is revoked locally either way. */
  revoke?(ctx: Ctx<C>, cred: Credential): Promise<void>;
  /** `refresh` needs no refresh token: it mints a new token from what the flow holds (client credentials, JWT bearer, GitHub Apps). */
  mints?: boolean;
  /** Device flow: the credential once the user approved, null while they haven't. A throw ends the attempt. */
  poll?(ctx: Ctx<C>, data: Json): Promise<Credential | null>;
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
  webhooks?: Webhooks<C, any>;
  /** Its config from the environment (`.config((env) => ...)`, #54): the host runs it with its env (`envConfig`). */
  configFrom?: ConfigFrom<C>;
  /** Its own events (#54), by name: what `conn.emit(name, data)` checks `data` against. Delivered as type `<name>`. */
  events?: Record<string, StandardSchemaV1>;
};

/**
 * Reads the environment for a connection's config: `env("NAME")` is required (a missing one leaves
 * the connection unconfigured, `not_configured`, with the names listed); `env.optional("NAME")` isn't.
 */
export type EnvReader = ((name: string) => string) & { optional(name: string): string | undefined };
export type ConfigFrom<C> = (env: EnvReader) => C;

/**
 * Run a connection's `configFrom` against `env`: its value (null while a required name is missing),
 * every name it reads (the host passes only those to the Worker) and the missing required ones.
 */
export function envConfig<C>(from: ConfigFrom<C>, env: Record<string, string | undefined>): { value: C | null; read: string[]; missing: string[] } {
  const read = new Set<string>();
  const missing = new Set<string>();
  // A plain read, not hasOwn: a Worker's `env` (cloudflare:workers) isn't a plain object. Non-strings (bindings, Object.prototype's) count as unset.
  const get = (n: string) => {
    read.add(n);
    const v = env[n];
    return typeof v === "string" && v ? v : undefined;
  };
  const reader = Object.assign(
    (n: string) => {
      const v = get(n);
      if (v === undefined) missing.add(n);
      return v ?? "";
    },
    { optional: get },
  );
  const value = from(reader);
  return { value: missing.size ? null : value, read: [...read], missing: [...missing] };
}

/** A webhook as the provider sent it. `body` is raw: verify before parsing. */
export type Webhook = { headers: Headers; body: string };

/**
 * A verified webhook: a handshake answered as is (Slack `url_verification`, GitHub `ping`), or an
 * event to deliver. `delivery` is the provider's id for it (receivers dedupe on it); `external`
 * names the account it's for, which routes app-level webhooks through the index (#26).
 */
export type Incoming = { reply: Json } | { topic: string; delivery?: string; payload: Json; external?: { key: string; value: string } };

/** `S`: what one subscription takes (`{ repo, events }`), when the definition has `subscription`. `T`: its topics. */
export type Webhooks<C, S = null, T extends string = string> = {
  /**
   * The topics it delivers, as `webhook.<topic>` events (#54): the typed client's event names. Others
   * are acknowledged and dropped. Without it, every topic is delivered (typed `webhook.${string}`).
   */
  // ponytail: names only, payloads stay Json; a schema per topic when payload types are worth their upkeep.
  topics?: readonly T[];
  /**
   * True if the provider sent it. `secret` is this connection's own webhook secret on
   * `/webhooks/:def/:id` (the one `register` handed the provider), null on the app-level route;
   * app-wide secrets (Slack's signing secret) come from config.
   */
  verify(ctx: Pick<Ctx<C>, "config" | "now">, req: Webhook, secret: string | null): Promise<boolean>;
  /** Read a verified webhook. A throw is a 400. */
  parse(req: Webhook): Incoming;
  /**
   * Explicit subscriptions (#54): the app creates any number per connection with
   * `webhooks.subscribe` (a GitHub repo hook each), passing what this schema checks; `register`
   * gets it as `input`. Without it, `register` runs once per connection on its own when it goes active.
   */
  subscription?: StandardSchemaV1<unknown, S>;
  /**
   * Create the provider-side subscription for an active connection, pointed at `endpoint`.
   * Returns what `unregister` needs, and when it lapses (Google channels) so it gets renewed. Null: nothing to register.
   * `hook` is stored unsealed and shown in the dashboard: ids only, no secrets.
   */
  // NoInfer: `S` comes from `subscription` only, so without one `input` is null (what the runtime passes).
  register?(ctx: Ctx<C>, cred: Credential, endpoint: { url: string; secret: string }, input: NoInfer<S>): Promise<{ hook: Json; expiresAt?: number } | null>;
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

/** A static credential without the field an `Inject` names. */
export class MissingField extends Error {}

export const BEARER: Inject = { header: "authorization", prefix: "Bearer " };

/** Put the credential on a request as `i` says. Throws if a static credential lacks the field. */
export function inject(i: Inject, url: URL, headers: Headers, cred: Credential) {
  if (typeof i === "function") return i(url, headers, cred);
  let v: string | undefined;
  if (cred.kind === "oauth2") v = cred.accessToken;
  else v = i.field ? cred.fields[i.field] : Object.values(cred.fields)[0];
  if (v === undefined) throw new MissingField(`credential has no field ${i.field ?? "(any)"}`);
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
  const conn = lifecycle(k, refresh ? { refresh: (c: OAuth2) => refresh(ctx, c), mints: !!def.auth.mints } : {});
  /** Who the credential belongs to; `{ m: null }` for a definition without `metadata`. */
  const metaCell = k.cell<{ m: Json }>("meta");
  /**
   * A device flow in progress: what the user was shown, what `poll` needs, and its attempt id (a
   * later connect or a revoke replaces or clears it, and a poll that lands late acts on nothing).
   * `claimed`: approved, the credential being activated. `pollAt`: when the next poll is due.
   */
  const deviceCell = k.cell<{ attempt: string; device: Device; data: Json; pollAt: number; claimed?: true }>("device");
  const live = async (attempt?: string) => {
    const d = (await deviceCell.read())?.value;
    return d && !d.claimed && (attempt === undefined || d.attempt === attempt) ? d : null;
  };
  /** Set the next poll, if the attempt is still the current one. */
  async function schedule(attempt: string, intervalMs: number) {
    const pollAt = k.now() + intervalMs;
    const d = await deviceCell.update((cur) => (cur?.attempt === attempt && !cur.claimed ? { ...cur, pollAt, device: { ...cur.device, intervalMs } } : null));
    if (d?.attempt === attempt && !d.claimed) await devicePoll.set(pollAt, attempt);
  }
  /** Tokens nobody will use (the attempt was replaced): revoke them at the provider, best effort. */
  const discard = (cred: Credential) => def.auth.revoke?.(ctx, cred).catch((e) => console.error("device flow: revoking a stale credential failed", k.instance, e));
  // ponytail: an expired or denied device attempt leaves the connection pending (no reason recorded); connect() again starts over.
  const devicePoll = k.timer<string>("device", {
    async handle(attempt): Promise<void> {
      const d = await live(attempt);
      if (!d || !def.auth.poll) return;
      if (k.now() >= d.device.expiresAt) {
        if (await live(attempt)) await deviceCell.delete();
        return;
      }
      let cred: Credential | null;
      try {
        cred = await def.auth.poll(ctx, d.data);
      } catch (e) {
        if (e instanceof OAuthError && e.code === "slow_down") return schedule(attempt, d.device.intervalMs + 5000);
        // A network failure or a provider 5xx: try again at the next interval, until the code expires.
        if (!(e instanceof OAuthError) || e.status >= 500) {
          console.error("device poll failed, retrying", k.instance, e);
          return schedule(attempt, d.device.intervalMs);
        }
        console.error("device flow ended", k.instance, e);
        if (await live(attempt)) await deviceCell.delete();
        return;
      }
      if (!cred) return schedule(attempt, d.device.intervalMs);
      // Claim the attempt: of a late poll and a reconnect (or revoke), only one goes on.
      let won = false;
      await deviceCell.update((cur) => {
        won = cur?.attempt === attempt && !cur.claimed;
        return won && cur ? { ...cur, claimed: true } : null;
      });
      if (!won) {
        await discard(cred);
        return;
      }
      await finish(cred).catch((e) => console.error("device flow: credential rejected", k.instance, e));
    },
  });
  /** A new connect or a revoke: the device attempt in progress (if any) stops. */
  async function endDevice() {
    if ((await deviceCell.read()) === null) return;
    await deviceCell.delete();
    await devicePoll.cancel();
  }

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
      await endDevice();
      if ("credential" in step) {
        await finish(step.credential);
        return null;
      }
      if (!s) await conn.pend();
      if ("device" in step) {
        const attempt = crypto.randomUUID();
        const pollAt = k.now() + step.device.intervalMs;
        await deviceCell.put({ attempt, device: step.device, data: step.data, pollAt });
        await devicePoll.set(pollAt, attempt);
        return step.device.verificationUriComplete ?? step.device.verificationUri;
      }
      return step.redirect(await conn.handshake.open({ data: step.data, ...(extra === undefined ? {} : { extra }) }));
    },

    handshake,

    /**
     * The device code to show the user while a device flow waits for approval; null otherwise. Also
     * the on-demand path: a poll overdue by a whole interval (its timer was lost) is set again.
     */
    async device(): Promise<Device | null> {
      const d = await live();
      if (!d || k.now() >= d.device.expiresAt) return null;
      if (k.now() > d.pollAt + d.device.intervalMs) await devicePoll.set(k.now(), d.attempt);
      return d.device;
    },

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
      await endDevice();
      const s = await conn.read();
      if (s?.credential && revoke) await revoke(ctx, s.credential).catch((e) => console.error("provider revoke failed", k.instance, e));
      return conn.revoke(reason);
    },
  };
}
