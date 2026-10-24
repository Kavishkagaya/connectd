import type { Json, Limit, Observed } from "@openconnect/kernel";
import { BEARER, type ConfigFrom, type Ctx, type Definition, type Inject, inject, type Webhooks } from "./define.ts";
import { type Flow, type Flows, flows, IDENTITY, STEPS } from "./flows.ts";
import type { Credential } from "./lifecycle.ts";
import { badEventName, type StandardSchemaV1 } from "./action.ts";

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
// ponytail: `.webhooks()` and `.events()` carry their types on `this`: a later stage (`.api()`,
// `.identity()`) drops them, so call them last. Carry them as type parameters if that order bites.
// ponytail: compiles to #17's `Definition`, so the runtime is unchanged. What a connection does lives outside it, in actions (action.ts).

// `Symbol.for`: a config bundled with its own copy of this package (`openconnect dev`) still matches.
const DEF = Symbol.for("openconnect.definition");

/**
 * A built connection: its id (a literal type, for the typed client) and what the runtime runs.
 * `A`: it has `.api()`, so actions on it get an authenticated `api` (#54).
 */
export type Connection<Id extends string = string, C = any, M extends Json = any, A extends boolean = boolean> = {
  readonly id: Id;
  readonly [DEF]: Definition<C, M>;
  /** Types only: whether `.api()` was called. */
  readonly "~api"?: A;
};

export type AnyConnection = Connection<string, any, any, boolean>;

/** A `connection(...)` builder (folder discovery picks these out of a module's exports). */
export const isConnection = (v: unknown): v is AnyConnection => typeof v === "object" && v !== null && DEF in v;

/** The definition a builder holds; a plain `Definition` as is. */
export function definitionOf<C, M extends Json>(d: Definition<C, M> | Connection<string, C, M>): Definition<C, M> {
  return DEF in d ? d[DEF] : d;
}

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

/**
 * The definition's API for one credential (or a getter: actions take the current token per call).
 * ponytail: calls here take no limiter permit; route them through the proxy's limiters when actions call the API often.
 */
export function apiFor(ctx: Pick<Ctx<unknown>, "fetch">, proxy: NonNullable<Definition<unknown, Json>["proxy"]>, cred: Credential | (() => Promise<Credential>)): Api {
  const call = async (path: string, init: RequestInit = {}) => {
    const url = new URL(`${proxy.baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`);
    const headers = new Headers(init.headers);
    inject(proxy.inject ?? BEARER, url, headers, typeof cred === "function" ? await cred() : cred);
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

interface Built<Id extends string, C, M extends Json, A extends boolean = false> extends Connection<Id, C, M, A> {
  /**
   * Incoming provider webhooks (#25): how to verify and read them, and optionally register one per
   * connection, or many with a `subscription` schema (#54). `S` types `webhooks.subscribe`.
   */
  webhooks<S = null, const T extends string = string>(webhooks: Webhooks<C, S, T>): this & { readonly "~subscription"?: S; readonly "~topics"?: T };
  /**
   * Its own events, by name (#54): `.events({ synced: z.object({ count: z.number() }) })`. Actions
   * send them with `conn.emit("synced", { count })`, checked against the schema; the app gets them as
   * events of type `synced`. Names: letters, digits, _ and -.
   */
  events<E extends Record<string, StandardSchemaV1>>(events: E): this & { readonly "~events"?: E };
}

/** `external` straight after auth, when the flow brings its own identity (OIDC claims). */
type External<Id extends string, C, M extends Json, A extends boolean> = {
  external(external: null extends M ? "needs .identity() first" : (identity: M) => Record<string, string>): Built<Id, C, M, A>;
};

/** `M`: the identity the flow brings by itself (OIDC claims), null for none. */
export interface Authed<Id extends string, C, M extends Json = null> extends Built<Id, C, M>, External<Id, C, M, false> {
  /** The provider's API: base URL and how the credential goes on. Backs the proxy (#23) and `identity`'s `api`. */
  api(spec: ApiSpec): WithApi<Id, C, M>;
  /** Who the credential belongs to. Runs before activation: a throw rejects the credential. Replaces a flow's own identity. */
  identity<N extends Json>(identify: (ctx: Ctx<C>, cred: Credential) => Promise<N>): Identified<Id, C, N, false>;
}

export interface WithApi<Id extends string, C, M extends Json = null> extends Built<Id, C, M, true>, External<Id, C, M, true> {
  /** Permits per connection and per app (`app:<id>`), taken on every proxied call. */
  limit(limits: { connection?: Limit; app?: Limit }): this;
  /** Read the provider's rate headers; only tightens the limits (`rateHeaders`). */
  observe(observe: (res: Response, now: number) => Observed): this;
  identity<N extends Json>(identify: (ctx: Ctx<C> & { api: Api }, cred: Credential) => Promise<N>): Identified<Id, C, N, true>;
}

export interface Identified<Id extends string, C, M extends Json, A extends boolean> extends Built<Id, C, M, A> {
  /** The provider's ids in the identity (Slack `teamId`), indexed for lookup (#26) and webhook routing (#25). */
  external(external: (identity: M) => Record<string, string>): Built<Id, C, M, A>;
}

// One object with every method; the stage types decide which are callable.
function make(def: Definition<any, any>): any {
  const next = (d: Partial<Definition<any, any>>) => make({ ...def, ...d });
  return {
    id: def.id,
    [DEF]: def,
    webhooks: (webhooks: Webhooks<unknown, unknown>) => next({ webhooks }),
    events: (events: Record<string, StandardSchemaV1>) => {
      for (const [name, schema] of Object.entries(events ?? {})) {
        const bad = badEventName(name);
        if (bad) throw new Error(`${def.id || "connection"}: event ${name}: the name is ${bad}`);
        if (typeof schema?.["~standard"]?.validate !== "function") throw new Error(`${def.id || "connection"}: event ${name} needs a schema (zod, valibot, arktype: Standard Schema)`);
      }
      return next({ events: { ...def.events, ...events } });
    },
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
      next({ metadata: (ctx, cred) => identify(def.proxy ? { ...ctx, api: apiFor(ctx, def.proxy, cred) } : ctx, cred) }),
    external: (external: (m: Json) => Record<string, string>) => next({ external }),
  };
}

/**
 * The same connection under another id: folder discovery names a connection after its folder
 * (`src/oc/gh/connection.ts` exporting `github` runs as `gh`).
 */
export function withId<T extends AnyConnection>(c: T, id: string): Omit<T, "id"> & { readonly id: string } {
  return c.id === id ? c : make({ ...definitionOf(c), id });
}

/**
 * Start a connection. `.config<C>()` names the config type (client id/secret, keys); leave it empty
 * for none. In a connection folder the id is the folder's name, so `connection()` takes none.
 */
export function connection<const Id extends string = string>(id: Id = "" as Id) {
  return {
    id,
    /**
     * `.config<C>()` names the config type and the host supplies it; `.config((env) => ({ clientId: env("GITHUB_CLIENT_ID") }))`
     * reads it from the environment: `env("NAME")`, `env.optional("NAME")` (one `.env`; only the names read here reach the Worker).
     */
    config: <C = null>(from?: ConfigFrom<C>) => ({
      /** How a credential is made: `f` holds the flows, already typed for this config. Runs once. */
      auth: <M extends Json = null>(pick: (f: Flows<C>) => Flow<C, M>): Authed<Id, C, M> => {
        const flow = pick(flows as unknown as Flows<C>);
        const own = flow[IDENTITY];
        return make({ id, auth: flow[STEPS], ...(from ? { configFrom: from } : {}), ...(own ? { metadata: async (_ctx: Ctx<C>, cred: Credential) => own(cred) } : {}) });
      },
    }),
  };
}
