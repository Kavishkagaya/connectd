import type { Credential, Device, State } from "@kavishkagaya/connectd-connections";
import type { Json } from "@kavishkagaya/connectd-kernel";
import type { ConnectionEvent, Fault, Page, Query, Row, SessionArgs } from "@kavishkagaya/connectd-runtime";
import { events, type EventsOptions } from "./events.ts";
import { isListener, type Listener } from "./listen.ts";
import { routes, type User } from "./routes.ts";
import type { ActionsOf, EntryOf, IdentityOf, Known, Registry, SubscriptionOf } from "./registry.ts";

// ponytail: depends on @kavishkagaya/connectd-runtime only for types (erased) and signature.ts (no imports);
// split signature.ts into its own package before publishing, so installing the SDK doesn't pull the runtime.

/**
 * The server SDK: a thin typed client over the runtime's HTTP API (#22, #23, #26). Fetch only, no
 * Node APIs, so it runs on Node 18+, Bun, Workers and Deno.
 *
 *   const oc = connectd({ url: "https://connect.example.com", apiKey });
 *   const gh = oc.connection("github", user.id);
 *   const { url } = await gh.connect();
 *   const res = await gh.fetch("/user", { retry: true });
 */

export type Options = {
  /** Base URL of the runtime's Worker. Default: `CONNECTD_URL` from the environment. */
  url?: string;
  /** Default: `CONNECTD_API_KEY` from the environment. */
  apiKey?: string;
  /** Who is signed in, for `routes` (#54): the user's id, or null. Their connection ids are it (or `<id>:<account>`). */
  user?: User;
  /** The folders' `listen()` handlers by connection id, for `routes`' events: `import { listeners } from "../.connectd/app"`. */
  listeners?: Record<string, Listener>;
  /** Event delivery for `routes` (default secret: `CONNECTD_EVENTS_SECRET`). */
  events?: Partial<EventsOptions>;
  /** The app's public origin, when `req.url` behind a proxy doesn't show it. */
  origin?: string;
  /** Default: global `fetch`. Tests pass the runtime's own fetch handler. */
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  /** How a 429 retry waits (default `setTimeout`); tests pass a fake clock. */
  sleep?: (ms: number) => Promise<void>;
};

/** `GET /connections/:def/:id`. `M`: the connection's identity, typed from the registry. */
export type Status<M = Json> = { state: State; reason?: string; metadata: M | null };

/** One webhook subscription (`webhooks.subscribe`), as the runtime stores it. */
export type Subscription<S = Json> = { id: string; input: S; hook: Json; renewAt: number | null; account: string | null; rev: string };

/** Opt-in retry of the runtime's own `429 rate_limited` on `fetch`. */
export type Retry = {
  /** Most waits before giving up (default 3). */
  attempts?: number;
  /** Most total time spent waiting (default 60s); a Retry-After past it fails at once. */
  maxWaitMs?: number;
};

export type ProxyInit = RequestInit & { retry?: boolean | Retry };

/** An error the runtime answered (`{ error: Fault }`), or a non-JSON failure in front of it (`code: "http_error"`). */
export class ConnectdError extends Error {
  readonly code: string;
  readonly status: number;
  /** `not_active`: the connection's state, and why. */
  readonly state?: string;
  readonly reason?: string;
  /** `rate_limited`: how long until a permit is free. */
  readonly retryAfterMs?: number;
  constructor(f: Fault & { retryAfterMs?: number }) {
    super(f.message);
    this.name = "ConnectdError";
    this.code = f.code;
    this.status = f.status;
    if (f.state !== undefined) this.state = f.state;
    if (f.reason !== undefined) this.reason = f.reason;
    if (f.retryAfterMs !== undefined) this.retryAfterMs = f.retryAfterMs;
  }
}

async function failure(res: Response): Promise<ConnectdError> {
  const text = await res.text();
  try {
    const e = (JSON.parse(text) as { error?: Fault }).error;
    if (e && typeof e.code === "string") return new ConnectdError({ ...e, status: res.status });
  } catch {}
  return new ConnectdError({ code: "http_error", status: res.status, message: text.slice(0, 200) || res.statusText });
}

/** The names the actions proxy answers: an action id that isn't reserved (`then`, `toJSON`, Object.prototype's). */
const actionName = (n: string) => /^[A-Za-z0-9_-]{1,64}$/.test(n) && n !== "then" && n !== "toJSON" && !(n in Object.prototype);

const sleeper = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * `R`: the project's registry (default: the generated one, `Registry`), so `connection("github", id)`
 * takes only known ids and its actions, status and subscriptions are typed.
 */
export function connectd<R = Registry>(o: Options = {}) {
  for (const [id, l] of Object.entries(o.listeners ?? {}))
    if (!isListener(l) || l.id !== id) throw new Error(`listeners.${id}: its events.ts must export default listen(${JSON.stringify(id)})`);
  // Read on first use: an app may build (import this) before its environment is set.
  const need = (v: string | undefined, name: string) => {
    if (!v) throw new Error(`${name} is not set (or pass it to connectd({ ... }))`);
    return v;
  };
  const baseUrl = () => need(o.url ?? env("CONNECTD_URL"), "CONNECTD_URL").replace(/\/+$/, "");
  // Wrapped: workerd's fetch throws "Illegal invocation" when called as a method.
  const f = o.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));
  const sleep = o.sleep ?? sleeper;
  const auth = () => `Bearer ${need(o.apiKey ?? env("CONNECTD_API_KEY"), "CONNECTD_API_KEY")}`;

  async function request<T>(method: "GET" | "POST", path: string, body?: Json): Promise<T> {
    const res = await f(baseUrl() + path, {
      method,
      headers: { authorization: auth(), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw await failure(res);
    return (await res.json()) as T;
  }

  /** One page of the index (#26). `cursor` is null on the last one. */
  function page(q: Query = {}): Promise<Page> {
    const p = new URLSearchParams();
    for (const k of ["def", "state", "q", "cursor"] as const) if (q[k]) p.set(k, q[k]);
    if (q.external) p.set("external", `${q.external.key}:${q.external.value}`);
    if (q.limit !== undefined) p.set("limit", String(q.limit));
    const s = p.toString();
    return request("GET", `/connections${s ? `?${s}` : ""}`);
  }

  /**
   * `base + path`, refused unless it still starts with `base + prefix` once resolved. URL parsing
   * removes `..` and `%2e%2e` segments, so a path like `../../connections/x/y/token` would
   * otherwise leave the proxy and reach the admin API with our API key.
   */
  function inside(prefix: string, path: string): string {
    const base = baseUrl();
    const u = new URL(base + prefix + path);
    if (!u.pathname.startsWith(new URL(base + prefix).pathname)) throw new ConnectdError({ code: "bad_request", status: 400, message: `path leaves ${prefix}: ${path}` });
    return u.href;
  }

  function connection<K extends Known<R>>(def: K, id: string) {
    type E = EntryOf<R, K>;
    // encodeURIComponent keeps dots, and a `.` or `..` segment would collapse the path.
    for (const s of [def, id]) if (s === "" || s === "." || s === "..") throw new ConnectdError({ code: "bad_request", status: 400, message: `bad definition or id: "${s}"` });
    const at = `${encodeURIComponent(def)}/${encodeURIComponent(id)}`;
    const call = async <T = Json>(method: string, args: Json = null) => {
      inside(`/connections/${at}/`, encodeURIComponent(method));
      return request<T>("POST", `/connections/${at}/${encodeURIComponent(method)}`, args);
    };

    /**
     * `fetch` through the proxy (#23): `path` (and query) is relative to the definition's base URL,
     * passed on as written, but it can't climb out of `/proxy/:def/:id/` (`..` throws `bad_request`).
     * Answers the provider's response, whatever its status; throws `ConnectdError` only for what
     * the runtime refused (not_active, rate_limited, upstream_timeout...), which it marks with
     * `connectd-error`. A failure in front of the runtime (a gateway's 502) has no marker, so it
     * comes back as a response, like the provider's.
     */
    async function proxied(path: string, init: ProxyInit = {}): Promise<Response> {
      const { retry, ...rest } = init;
      const r = retry ? (retry === true ? {} : retry) : null;
      const headers = new Headers(rest.headers);
      headers.set("authorization", auth());
      const stream = rest.body instanceof ReadableStream;
      // duplex: required by Node's fetch to send a stream (not in the DOM RequestInit types yet).
      const req = { ...rest, headers, ...(stream ? ({ duplex: "half" } as {}) : {}) };
      const url = inside(`/proxy/${at}/`, path.replace(/^\/+/, ""));
      let waited = 0;
      for (let attempt = 0; ; attempt++) {
        const res = await f(url, req);
        if (!res.headers.has("connectd-error")) return res;
        const e = await failure(res);
        // Our 429 means the provider was never called, so a retry is safe for any method.
        // ponytail: a stream body can't be sent twice; buffer it yourself to retry one.
        const wait = e.retryAfterMs ?? Number(res.headers.get("retry-after")) * 1000;
        if (!r || e.code !== "rate_limited" || stream || attempt >= (r.attempts ?? 3) || waited + wait > (r.maxWaitMs ?? 60_000)) throw e;
        await sleep(wait);
        waited += wait;
      }
    }

    return {
      def,
      id,
      status: () => request<Status<IdentityOf<E>>>("GET", `/connections/${at}`),
      /**
       * Start (or redo) authorization. `url` is where to send the user; null if it finished inline
       * (API keys: pass the fields as `args`). For a user in a browser, prefer `session()` and
       * `@kavishkagaya/connectd-connect`: this URL isn't tied to the browser that opens it, so anyone who
       * gets it (a user of your app sending it to someone else) can have another person's provider
       * account land on this connection (login CSRF). Sessions bind the flow to the browser and the
       * result to your page. A device flow (#56) also returns `device`: show its `userCode` and
       * `verificationUri`; the runtime polls, and the connection goes active once the user approves.
       */
      connect: (args: Record<string, string> = {}) => call<{ url: string | null; device?: Device }>("connect", args),
      /** A current credential, refreshed if due. Prefer `fetch`, which never hands the token out. */
      token: () => call<Credential>("token"),
      revoke: (reason?: string) => call<Status<IdentityOf<E>>>("revoke", reason === undefined ? null : { reason }),
      /**
       * A short-lived token for the browser (#29, `@kavishkagaya/connectd-connect`): it can start this
       * connection's authorization from `origin` (or `returnUrl`'s), and nothing else. Both must be in
       * the runtime's `settings.sessions.origins`; `returnUrl` is where a redirect-mode flow ends.
       */
      session: (o: SessionArgs) => call<{ token: string; expiresAt: number; flow: "redirect" | "form" }>("session", o),
      /**
       * A link to the runtime's own connect page (#54): a button for the provider, or a form for an
       * API key; then the user goes to `next` (`?connectd=connected&definition=&id=`). For a user
       * who isn't in your app's browser session (an email, a chat): whoever opens it first can connect
       * this connection (it works once), so send it only to that user, and keep `ttlMs` short.
       * `confirm`: the page hands `next` the outcome to confirm instead (`oc.routes` does, for API keys).
       */
      link: (o: { next?: string; ttlMs?: number; confirm?: boolean } = {}) => call<{ url: string; expiresAt: number }>("session", { hosted: true, ...o }),
      /**
       * The connection's actions (#54): `gh.actions.star({ repo })` runs `star` in this connection's
       * instance (`POST /connections/:def/:id/actions/star`). Input is checked by the action's schema
       * on the server (`bad_request` with `issues`); the connection must be active (`not_active`).
       */
      actions: new Proxy({} as ActionsOf<E>, {
        // Action ids only: not thenable (`await gh.actions` stays the proxy), and `toJSON`, `toString`
        // and other Object.prototype names (a logger, String(), a dev tool) never reach the server.
        get: (_t, name) => (typeof name === "string" && actionName(name) ? (input?: Json) => call(`actions.${name}`, input ?? null) : undefined),
      }),
      /** Webhook subscriptions (#54), for definitions with a `subscription` schema (GitHub: `{ repo, events? }`). */
      webhooks: {
        // Method syntax: a typed connection stays assignable to the untyped `Connection`.
        subscribe(input: SubscriptionOf<E>) {
          return call<Subscription<SubscriptionOf<E>>>("webhooks.subscribe", input as Json);
        },
        list: () => call<Subscription<SubscriptionOf<E>>[]>("webhooks.list"),
        unsubscribe: (subscription: string) => call<null>("webhooks.unsubscribe", { id: subscription }),
      },
      /** Any other connection method (extensions': `index.sync`, `webhooks.endpoint`, ...). */
      call,
      fetch: proxied,
    };
  }

  // Annotated: the events handler's types name the client's own, which include `routes`.
  type Handle = { handle(req: Request): Promise<Response> };
  let ev: Handle | undefined;
  /** The listeners' handlers on one events handler, each for its own connection's events only. */
  const listening = (): Handle => {
    if (ev) return ev;
    const e = events<{}>({ ...o.events, secret: need(o.events?.secret ?? env("CONNECTD_EVENTS_SECRET"), "CONNECTD_EVENTS_SECRET") }, (def, id) => connection(def as Known<R>, id) as unknown as Connection);
    for (const l of Object.values(o.listeners ?? {}))
      for (const [type, h] of l.handlers) e.on(type as "*", (event: ConnectionEvent, conn: Connection) => (event.connection.definition === l.id ? (h as (e: unknown, c: unknown) => unknown)(event, conn) : undefined));
    return (ev = e);
  };
  const client = {
    connection,
    connections: {
      page,
      /** Every matching connection, following cursors: `for await (const c of oc.connections.list({ state: "active" }))`. */
      async *list(q: Omit<Query, "cursor"> = {}): AsyncGenerator<Row> {
        let cursor: string | null = null;
        do {
          const p: Page = await page({ ...q, ...(cursor ? { cursor } : {}) });
          yield* p.connections;
          cursor = p.cursor;
        } while (cursor);
      },
    },
    /** The receiving end of event delivery (#24); handlers get the event's connection as a client. */
    events: (e: EventsOptions) => events<R>(e, (def, id) => connection(def as Known<R>, id) as unknown as Connection),
    /** The app's route (#54): `export const { GET, POST } = oc.routes` (connect, return, events; see routes.ts). */
    routes: routes({
      base: baseUrl,
      fetch: f,
      connection: (def, id) => connection(def as Known<R>, id),
      events: listening,
      ...(o.user ? { user: o.user } : {}),
      ...(o.origin ? { origin: o.origin } : {}),
    }),
  };
  return client;
}

/** The process environment where there is one (Node, Bun); never required: Workers and Deno pass options. */
const env = (name: string): string | undefined => (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];

export type Client<R = Registry> = ReturnType<typeof connectd<R>>;
/** A connection client, untyped (events hand these out: any definition). */
export type Connection = ReturnType<ReturnType<typeof connectd<{}>>["connection"]>;
