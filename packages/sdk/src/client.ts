import type { Credential, State } from "@openconnect/connections";
import type { Json } from "@openconnect/kernel";
import type { Fault, Page, Query, Row, SessionArgs } from "@openconnect/runtime";
import { events, type EventsOptions } from "./events.ts";

// ponytail: depends on @openconnect/runtime only for types (erased) and signature.ts (no imports);
// split signature.ts into its own package before publishing, so installing the SDK doesn't pull the runtime.

/**
 * The server SDK: a thin typed client over the runtime's HTTP API (#22, #23, #26). Fetch only, no
 * Node APIs, so it runs on Node 18+, Bun, Workers and Deno.
 *
 *   const oc = openconnect({ url: "https://connect.example.com", apiKey });
 *   const gh = oc.connection("github", user.id);
 *   const { url } = await gh.connect();
 *   const res = await gh.fetch("/user", { retry: true });
 */

export type Options = {
  /** Base URL of the runtime's Worker. */
  url: string;
  apiKey: string;
  /** Default: global `fetch`. Tests pass the runtime's own fetch handler. */
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  /** How a 429 retry waits (default `setTimeout`); tests pass a fake clock. */
  sleep?: (ms: number) => Promise<void>;
};

/** `GET /connections/:def/:id`. */
export type Status = { state: State; reason?: string; metadata: Json };

/** Opt-in retry of the runtime's own `429 rate_limited` on `fetch`. */
export type Retry = {
  /** Most waits before giving up (default 3). */
  attempts?: number;
  /** Most total time spent waiting (default 60s); a Retry-After past it fails at once. */
  maxWaitMs?: number;
};

export type ProxyInit = RequestInit & { retry?: boolean | Retry };

/** An error the runtime answered (`{ error: Fault }`), or a non-JSON failure in front of it (`code: "http_error"`). */
export class OpenConnectError extends Error {
  readonly code: string;
  readonly status: number;
  /** `not_active`: the connection's state, and why. */
  readonly state?: string;
  readonly reason?: string;
  /** `rate_limited`: how long until a permit is free. */
  readonly retryAfterMs?: number;
  constructor(f: Fault & { retryAfterMs?: number }) {
    super(f.message);
    this.name = "OpenConnectError";
    this.code = f.code;
    this.status = f.status;
    if (f.state !== undefined) this.state = f.state;
    if (f.reason !== undefined) this.reason = f.reason;
    if (f.retryAfterMs !== undefined) this.retryAfterMs = f.retryAfterMs;
  }
}

async function failure(res: Response): Promise<OpenConnectError> {
  const text = await res.text();
  try {
    const e = (JSON.parse(text) as { error?: Fault }).error;
    if (e && typeof e.code === "string") return new OpenConnectError({ ...e, status: res.status });
  } catch {}
  return new OpenConnectError({ code: "http_error", status: res.status, message: text.slice(0, 200) || res.statusText });
}

const sleeper = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function openconnect(o: Options) {
  const base = o.url.replace(/\/+$/, "");
  // Wrapped: workerd's fetch throws "Illegal invocation" when called as a method.
  const f = o.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));
  const sleep = o.sleep ?? sleeper;
  const auth = `Bearer ${o.apiKey}`;

  async function request<T>(method: "GET" | "POST", path: string, body?: Json): Promise<T> {
    const res = await f(base + path, {
      method,
      headers: { authorization: auth, ...(body === undefined ? {} : { "content-type": "application/json" }) },
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
    const u = new URL(base + prefix + path);
    if (!u.pathname.startsWith(new URL(base + prefix).pathname)) throw new OpenConnectError({ code: "bad_request", status: 400, message: `path leaves ${prefix}: ${path}` });
    return u.href;
  }

  function connection(def: string, id: string) {
    // encodeURIComponent keeps dots, and a `.` or `..` segment would collapse the path.
    for (const s of [def, id]) if (s === "" || s === "." || s === "..") throw new OpenConnectError({ code: "bad_request", status: 400, message: `bad definition or id: "${s}"` });
    const at = `${encodeURIComponent(def)}/${encodeURIComponent(id)}`;
    const call = async <T = Json>(method: string, args: Json = null) => {
      inside(`/connections/${at}/`, encodeURIComponent(method));
      return request<T>("POST", `/connections/${at}/${encodeURIComponent(method)}`, args);
    };

    /**
     * `fetch` through the proxy (#23): `path` (and query) is relative to the definition's base URL,
     * passed on as written, but it can't climb out of `/proxy/:def/:id/` (`..` throws `bad_request`).
     * Answers the provider's response, whatever its status; throws `OpenConnectError` only for what
     * the runtime refused (not_active, rate_limited, upstream_timeout...), which it marks with
     * `openconnect-error`. A failure in front of the runtime (a gateway's 502) has no marker, so it
     * comes back as a response, like the provider's.
     */
    async function proxied(path: string, init: ProxyInit = {}): Promise<Response> {
      const { retry, ...rest } = init;
      const r = retry ? (retry === true ? {} : retry) : null;
      const headers = new Headers(rest.headers);
      headers.set("authorization", auth);
      const stream = rest.body instanceof ReadableStream;
      // duplex: required by Node's fetch to send a stream (not in the DOM RequestInit types yet).
      const req = { ...rest, headers, ...(stream ? ({ duplex: "half" } as {}) : {}) };
      const url = inside(`/proxy/${at}/`, path.replace(/^\/+/, ""));
      let waited = 0;
      for (let attempt = 0; ; attempt++) {
        const res = await f(url, req);
        if (!res.headers.has("openconnect-error")) return res;
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
      status: () => request<Status>("GET", `/connections/${at}`),
      /**
       * Start (or redo) authorization. `url` is where to send the user; null if it finished inline
       * (API keys: pass the fields as `args`). For a user in a browser, prefer `session()` and
       * `@openconnect/connect`: this URL isn't tied to the browser that opens it, so anyone who
       * gets it (a user of your app sending it to someone else) can have another person's provider
       * account land on this connection (login CSRF). Sessions bind the flow to the browser and the
       * result to your page.
       */
      connect: (args: Record<string, string> = {}) => call<{ url: string | null }>("connect", args),
      /** A current credential, refreshed if due. Prefer `fetch`, which never hands the token out. */
      token: () => call<Credential>("token"),
      revoke: (reason?: string) => call<Status>("revoke", reason === undefined ? null : { reason }),
      /**
       * A short-lived token for the browser (#29, `@openconnect/connect`): it can start this
       * connection's authorization from `origin` (or `returnUrl`'s), and nothing else. Both must be in
       * the runtime's `settings.sessions.origins`; `returnUrl` is where a redirect-mode flow ends.
       */
      session: (o: SessionArgs) => call<{ token: string; expiresAt: number }>("session", o),
      /** Any other connection method (extensions': `index.sync`, `webhooks.endpoint`, ...). */
      call,
      fetch: proxied,
    };
  }

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
    events: (e: EventsOptions) => events(e, connection),
  };
  return client;
}

export type Client = ReturnType<typeof openconnect>;
export type Connection = ReturnType<Client["connection"]>;
