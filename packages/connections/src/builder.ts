import type { Json, Limit, Observed } from "@openconnect/kernel";
import { apiKey as apiKeySteps, deadAs, type OAuth2Config, type OAuth2Spec, oauth2Steps } from "./auth.ts";
import { type Auth, BEARER, type Ctx, type Definition, type Inject, inject, type Webhooks } from "./define.ts";
import { type Credential, credentialFrom, type OAuth2 } from "./lifecycle.ts";
import type { TokenResponse } from "./oauth.ts";

/**
 * The connection builder (#54): an ordered, typed core.
 *
 *   connection("github")
 *     .config<GitHubConfig>()
 *     .auth((f) => f.oauth2({ authorizeUrl, tokenUrl }).scopes("read:user"))
 *     .api({ baseUrl: "https://api.github.com" }).limit({ connection: { count: 5000, periodMs: HOUR } })
 *     .identity(async ({ api }) => api.get("/user"))
 *     .external((me) => ({ id: me.id }))
 *
 * Immutable: every call returns a new builder, so a partial is safe to share. No `.build()`: the
 * builder is the definition, and the runtime reads it with `definitionOf`. Each step sees the types
 * of the ones before it, and the types allow only this order.
 */
// ponytail: compiles to #17's `Definition`, so the runtime is unchanged; capabilities (`.use()`) replace that shape with the host's move off extensions.

// `Symbol.for`: a config bundled with its own copy of this package (`openconnect dev`) still matches.
const DEF = Symbol.for("openconnect.definition");
const STEPS = Symbol.for("openconnect.flow");

/** A built connection: its id (a literal type, for the typed client) and what the runtime runs. */
export type Connection<Id extends string = string, C = any, M extends Json = any> = { readonly id: Id; readonly [DEF]: Definition<C, M> };

export type AnyConnection = Connection<string, any, any>;

/** The definition a builder holds; a plain `Definition` as is. */
export function definitionOf<C, M extends Json>(d: Definition<C, M> | Connection<string, C, M>): Definition<C, M> {
  return DEF in d ? d[DEF] : d;
}

/** An auth flow, as `.auth()` takes it. */
export type Flow<C> = { readonly [STEPS]: Auth<C> };

/** The standard step (or the override before this one), for an override to call. */
type Next<A, R> = (a: A) => Promise<R>;
type Override<C, A, R> = (ctx: Ctx<C>, a: A, next: Next<A, R>) => Promise<R>;

/** Code for tokens. Return the token response; the flow turns it into the credential. */
export type CallbackStep<C> = Override<C, Record<string, string>, TokenResponse>;
/** Refresh token for tokens. A provider code passed to `deadRefreshToken` still means `invalid_grant`. */
export type RefreshStep<C> = Override<C, OAuth2, TokenResponse>;
export type RevokeStep<C> = Override<C, Credential, void>;

/** Authorization code (+ PKCE) as a builder: data in the constructor, quirks as methods. Each returns a new flow. */
export interface OAuth2Flow<C> extends Flow<C> {
  /** Default scopes; replaces earlier ones. Config `scopes` and the connect call's `scope` take precedence. */
  scopes(...scopes: string[]): OAuth2Flow<C>;
  /** Default " ". */
  scopeSeparator(separator: string): OAuth2Flow<C>;
  /** Extra authorize params (Google `access_type`); a function when they come from config. */
  params(params: Record<string, string> | ((config: C) => Record<string, string>)): OAuth2Flow<C>;
  /** Default on. */
  pkce(on: boolean): OAuth2Flow<C>;
  clientAuth(how: "basic" | "post"): OAuth2Flow<C>;
  /** The provider's error codes for a dead refresh token (GitHub `bad_refresh_token`). */
  deadRefreshToken(...codes: string[]): OAuth2Flow<C>;
  /** Override a step: call `next` to run the standard one and adjust its result, or don't, to replace it. */
  callback(step: CallbackStep<C>): OAuth2Flow<C>;
  refresh(step: RefreshStep<C>): OAuth2Flow<C>;
  revoke(step: RevokeStep<C>): OAuth2Flow<C>;
}

type OAuth2State<C> = { spec: OAuth2Spec<C>; callback?: CallbackStep<C>; refresh?: RefreshStep<C>; revoke?: RevokeStep<C> };

/** `step` around `prev`: inside `step`, `next` is the step as it was before (the standard one at the bottom). */
const around =
  <C, A, R>(prev: Override<C, A, R> | undefined, step: Override<C, A, R>): Override<C, A, R> =>
  (ctx, a, next) =>
    step(ctx, a, (b) => (prev ? prev(ctx, b, next) : next(b)));

const run = <C, A, R>(o: Override<C, A, R> | undefined, ctx: Ctx<C>, a: A, std: Next<A, R>) => (o ? o(ctx, a, std) : std(a));

function oauth2Flow<C extends OAuth2Config>(st: OAuth2State<C>): OAuth2Flow<C> {
  const set = (p: Partial<OAuth2Spec<C>>) => oauth2Flow({ ...st, spec: { ...st.spec, ...p } });
  const s = oauth2Steps(st.spec);
  const steps: Auth<C> = {
    start: s.start,
    callback: async (ctx, params, data) => credentialFrom(await run(st.callback, ctx, params, (p) => s.exchange(ctx, p, data)), ctx.now()),
    refresh: (ctx, cred) => deadAs(st.spec.invalidGrant, run(st.refresh, ctx, cred, (c) => s.grant(ctx, c))),
    ...(st.spec.revokeUrl || st.revoke ? { revoke: (ctx: Ctx<C>, cred: Credential) => run(st.revoke, ctx, cred, (c) => s.revoke(ctx, c)) } : {}),
  };
  return {
    [STEPS]: steps,
    scopes: (...scopes) => set({ scopes }),
    scopeSeparator: (scopeSeparator) => set({ scopeSeparator }),
    params: (params) => set({ params }),
    pkce: (on) => set({ pkce: on }),
    clientAuth: (clientAuth) => set({ clientAuth }),
    deadRefreshToken: (...invalidGrant) => set({ invalidGrant }),
    callback: (step) => oauth2Flow({ ...st, callback: around(st.callback, step) }),
    refresh: (step) => oauth2Flow({ ...st, refresh: around(st.refresh, step) }),
    revoke: (step) => oauth2Flow({ ...st, revoke: around(st.revoke, step) }),
  };
}

/** The flows `.auth()` hands its callback, bound to the connection's config type. */
export type Flows<C> = {
  oauth2: C extends OAuth2Config
    ? (endpoints: { authorizeUrl: string; tokenUrl: string; revokeUrl?: string }) => OAuth2Flow<C>
    : { error: "oauth2 needs a config with clientId (and clientSecret)" };
  /** A static credential from fields the user enters (API key, username + password). `identity` checks it. */
  apiKey(...fields: string[]): Flow<C>;
  /** A fully custom flow, written as steps (the OAuth atoms in `oauth.ts` help). */
  flow(steps: Auth<C>): Flow<C>;
};

const flows = {
  oauth2: (endpoints: { authorizeUrl: string; tokenUrl: string; revokeUrl?: string }) => oauth2Flow<OAuth2Config>({ spec: endpoints }),
  apiKey: (...fields: string[]) => ({ [STEPS]: apiKeySteps(fields) }),
  flow: (steps: Auth<unknown>) => ({ [STEPS]: steps }),
};

/** The provider's API, authenticated: paths are relative to `.api()`'s base URL. */
export type Api = {
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** GET as JSON; throws on a non-2xx. */
  get<T = Json>(path: string): Promise<T>;
};

export type ApiSpec = {
  // ponytail: one fixed base URL; a function of the credential when a provider needs a per-connection host (Salesforce instance_url).
  baseUrl: string;
  /** Sent on every request unless the request sets them (GitHub's `user-agent`). */
  headers?: Record<string, string>;
  /** Where the credential goes. Default `Authorization: Bearer <token>`, or a static credential's first field. */
  key?: Inject;
};

// ponytail: calls here take no limiter permit (identity makes one per login); route them through the proxy's limiters when capabilities call the API often.
function api(ctx: Ctx<unknown>, proxy: NonNullable<Definition<unknown, Json>["proxy"]>, cred: Credential): Api {
  const call = (path: string, init: RequestInit = {}) => {
    const url = new URL(`${proxy.baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`);
    const headers = new Headers(init.headers);
    inject(proxy.inject ?? BEARER, url, headers, cred);
    return ctx.fetch(url.toString(), { ...init, headers });
  };
  return {
    fetch: call,
    async get<T>(path: string) {
      const res = await call(path);
      if (!res.ok) throw new Error(`${path} ${res.status}`);
      return (await res.json()) as T;
    },
  };
}

interface Built<Id extends string, C, M extends Json> extends Connection<Id, C, M> {
  /** Incoming provider webhooks (#25): how to verify and read them, and optionally register one per connection. */
  webhooks(webhooks: Webhooks<C>): this;
}

export interface Authed<Id extends string, C> extends Built<Id, C, null> {
  /** The provider's API: base URL and how the credential goes on. Backs the proxy (#23) and `identity`'s `api`. */
  api(spec: ApiSpec): WithApi<Id, C>;
  /** Who the credential belongs to. Runs before activation: a throw rejects the credential. */
  identity<M extends Json>(identify: (ctx: Ctx<C>, cred: Credential) => Promise<M>): Identified<Id, C, M>;
}

export interface WithApi<Id extends string, C> extends Built<Id, C, null> {
  /** Permits per connection and per app (`app:<id>`), taken on every proxied call. */
  limit(limits: { connection?: Limit; app?: Limit }): this;
  /** Read the provider's rate headers; only tightens the limits (`rateHeaders`). */
  observe(observe: (res: Response, now: number) => Observed): this;
  identity<M extends Json>(identify: (ctx: Ctx<C> & { api: Api }, cred: Credential) => Promise<M>): Identified<Id, C, M>;
}

export interface Identified<Id extends string, C, M extends Json> extends Built<Id, C, M> {
  /** The provider's ids in the identity (Slack `teamId`), indexed for lookup (#26) and webhook routing (#25). */
  external(external: (identity: M) => Record<string, string>): Built<Id, C, M>;
}

// One object with every method; the stage types decide which are callable.
function make(def: Definition<any, any>): any {
  const next = (d: Partial<Definition<any, any>>) => make({ ...def, ...d });
  return {
    id: def.id,
    [DEF]: def,
    webhooks: (webhooks: Webhooks<unknown>) => next({ webhooks }),
    api: (s: ApiSpec) => {
      const headers = Object.entries(s.headers ?? {});
      const key = s.key ?? BEARER;
      const put: Inject = (url, h, cred) => {
        for (const [k, v] of headers) if (!h.has(k)) h.set(k, v);
        inject(key, url, h, cred);
      };
      return next({ proxy: { baseUrl: s.baseUrl, ...(headers.length ? { inject: put } : s.key ? { inject: s.key } : {}) } });
    },
    limit: (l: { connection?: Limit; app?: Limit }) => next({ rate: { ...def.rate, ...l } }),
    observe: (observe: (res: Response, now: number) => Observed) => next({ rate: { ...def.rate, observe } }),
    identity: (identify: (ctx: Ctx<unknown> & { api?: Api }, cred: Credential) => Promise<Json>) =>
      next({ metadata: (ctx, cred) => identify(def.proxy ? { ...ctx, api: api(ctx, def.proxy, cred) } : ctx, cred) }),
    external: (external: (m: Json) => Record<string, string>) => next({ external }),
  };
}

/** Start a connection. `.config<C>()` names the config type (client id/secret, keys); leave it empty for none. */
export function connection<const Id extends string>(id: Id) {
  return {
    id,
    config: <C = null>() => ({
      /** How a credential is made: `f` holds the flows, already typed for this config. Runs once. */
      auth: (pick: (f: Flows<C>) => Flow<C>): Authed<Id, C> => make({ id, auth: pick(flows as unknown as Flows<C>)[STEPS] }),
    }),
  };
}
