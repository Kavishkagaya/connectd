import { bind, type Definition, IllegalTransition, InputError, NotActive, OAuthError, safeEqual } from "@openconnect/connections";
import { type Driver, handleRate, type Json, type Kernel, type Keys, kernel, type Program, RATE, type Ticket } from "@openconnect/kernel";

/**
 * The connection host: one Program that runs any definition from a registry, one instance per
 * connection. Each instance gets one kernel (#53); the lifecycle (`bind`) and every extension
 * declare their tools on it, and `serve` routes timers to them. Definition code only ever sees its
 * `ctx` (config, fetch, redirectUri, now), never the kernel, so a hook that throws can't leave
 * anything half-written.
 */

// Definitions differ in config and metadata types; the registry holds any of them.
export type AnyDefinition = Definition<any, any>;
export type Bound = ReturnType<typeof bind<unknown, Json>>;

/** Per deployment. Loaded once per isolate, lazily (Workers can't do crypto at global scope). */
export type Settings = {
  keys: Keys;
  /** HMAC key for handshake `state`. */
  stateKey: CryptoKey;
  /** Bearer token for every non-public route. */
  apiKey: string;
  /** This deployment's `/callback` URL, registered with every provider. */
  redirectUri: string;
  /** Connector config per definition id (client id/secret). */
  // ponytail: one app per deployment; per-app config moves to an app instance via `secrets` (#10) when multi-app.
  config: Record<string, unknown>;
  /** Outbound fetch for definitions; tests pass a fake. */
  fetch?: typeof fetch;
  /** Where the events extension delivers, and the `whsec_...` secret it signs with (#24). */
  events?: { url: string; secret: string };
  /** Public base URL of the `/webhooks` route, and the HMAC key each connection's webhook secret derives from (#25). */
  webhooks?: { url: string; key: CryptoKey };
  /**
   * Frontend connect sessions (#29): the HMAC key session tokens are signed with, and the exact
   * origins (`https://app.example.com`) a browser may call from and be sent back to.
   */
  sessions?: { key: CryptoKey; origins: string[] };
};

/**
 * Where a frontend session's authorization ends (#29): stored with the handshake, handed back by
 * `callback`. `cookie` is set in the browser that opened the ticket and checked at the callback.
 */
export type Target = {
  mode: "popup" | "redirect";
  origin: string;
  returnUrl?: string;
  nonce: string;
  cookie: { name: string; value: string };
  definition: string;
  id: string;
};

/** The callback route passes the request's Cookie header to `callback` under this key (never taken from the query). */
export const COOKIES = "openconnect.cookies";

const cookie = (header: string, name: string) =>
  header
    .split(";")
    .map((c) => c.trim().split("="))
    .find(([k]) => k === name)?.[1];

/** `issues`: what an action's input schema rejected (#54). */
export type Fault = { code: string; status: number; message: string; state?: string; reason?: string; issues?: Json };
/** Every connection method replies with this; error classes don't survive a DO RPC, so faults are data. */
export type Reply = { ok: Json } | { error: Fault };
export type Method = (args: Json) => Promise<Json>;

/**
 * What an extension sees of one hosted connection. `k` is the instance's kernel: declare cells,
 * timers, queues and tickets on it once (stored names `<extension>.<name>`). `done` holds a session's
 * authorized credential for `session.complete` (#29).
 */
export type Hosted = { k: Kernel; instance: string; def: AnyDefinition; id: string; bound: Bound; settings: Settings; done: Ticket<string> };

/** An extension's per-connection part. Created once per instance, next to `bind`. Timers are declared on `k`. */
export type Hooks = {
  /** Extra methods, reachable by RPC and by `POST /connections/:def/:id/:method`. Built-ins win on a name clash. */
  methods?: Record<string, Method>;
  /** After every method or timer on this connection, failed ones too (state may have moved anyway). Errors are logged. */
  after?(cause: string): Promise<void>;
  /** Before `revoke`, while the credential is still there (webhooks unregister). Errors are logged; the revoke goes on. */
  beforeRevoke?(): Promise<void>;
};

/** Thrown by runtime and extension code for a failure with its own HTTP status. */
export class Fail extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly issues?: Json,
  ) {
    super(message);
  }
}

/** Connection instance key. The definition id is part of it, so a DO knows what to run with no lookup. */
export const instanceOf = (def: string, id: string) => `conn:${def}:${id}`;

export function fault(e: unknown, instance: string): Fault {
  if (e instanceof Fail) return { code: e.code, status: e.status, message: e.message, ...(e.issues === undefined ? {} : { issues: e.issues }) };
  if (e instanceof InputError) return { code: "bad_request", status: 400, message: e.message };
  if (e instanceof NotActive)
    return { code: "not_active", status: 409, message: e.message, state: e.state ?? "missing", ...(e.reason ? { reason: e.reason } : {}) };
  if (e instanceof IllegalTransition) return { code: "illegal_transition", status: 409, message: e.message };
  // The provider (or the user at the consent screen) said no; a provider 5xx is a bad gateway.
  if (e instanceof OAuthError) return { code: e.code, status: e.status >= 500 ? 502 : 400, message: e.message };
  // Definition code or a kernel bug. The record is intact either way: hooks run before any cas.
  console.error("connection error", instance, e);
  return { code: "error", status: 500, message: e instanceof Error ? e.message : String(e) };
}

function input(a: Json): Record<string, string> {
  if (a === null) return {};
  if (typeof a === "object" && !Array.isArray(a) && Object.values(a).every((v) => typeof v === "string")) return a as Record<string, string>;
  throw new Fail("bad_request", 400, "expected an object of strings");
}

async function status(b: Bound): Promise<Json> {
  const s = await b.conn.read();
  if (!s) throw new Fail("not_found", 404, "no such connection");
  return { state: s.state, ...(s.reason ? { reason: s.reason } : {}), metadata: await b.metadata() };
}

/** How long a session's authorized credential waits for `session.complete` (#29). */
const DONE_TTL_MS = 600_000;

const builtins = (b: Bound, hooks: Hooks[], instance: string, k: Kernel, done: Ticket<string>): Record<string, Method> => ({
  connect: async (a) => {
    const url = await b.connect(input(a));
    // A device flow (#56): the code to show the user, polled for in the background.
    const device = url === null ? null : await b.device();
    return { url, ...(device ? { device } : {}) };
  },
  callback: async (a) => {
    const { [COOKIES]: cookies = "", ...params } = input(a);
    const hs = await b.handshake(params);
    const target = hs.extra as Target | undefined;
    if (!target) {
      await b.callback(params, hs);
      return status(b);
    }
    // A session's handshake finishes only in the browser that opened its ticket, so a victim can't be
    // sent to the provider with someone else's flow (login CSRF). Errors go back to the target as data.
    try {
      if (!(await safeEqual(cookie(cookies, target.cookie.name) ?? "", target.cookie.value)))
        throw new Fail("session_mismatch", 403, "this browser did not start the authorization");
      // Not activated yet: the credential waits, sealed, for the app's page to confirm (#29), since
      // whoever started the flow (a ticket can be minted outside a browser) may not be this browser's user.
      // The completion is a one-time kernel ticket: only a reference reaches the browser.
      const completion = await done.issue(await k.seal((await b.exchange(params, hs)) as unknown as Json));
      return { target, completion };
    } catch (e) {
      return { target, error: fault(e, instance) } as unknown as Json;
    }
  },
  token: async () => await b.token(),
  status: () => status(b),
  revoke: async (a) => {
    const reason = (a as { reason?: Json } | null)?.reason;
    for (const h of hooks) await h.beforeRevoke?.().catch((e) => console.error("before revoke", instance, e));
    await b.revoke(typeof reason === "string" ? reason : undefined);
    return status(b);
  },
});

export function host(o: { definitions: Record<string, AnyDefinition>; settings: () => Promise<Settings>; connection: ((h: Hosted) => Hooks)[] }): Program {
  async function init(d: Driver, instance: string) {
    const m = /^conn:([^:]+):(.+)$/.exec(instance);
    // ponytail: other instances (app-scope limiters) only answer RATE; give them a kernel when an extension needs one.
    if (!m) return null;
    const [, defId, id] = m as unknown as [string, string, string];
    const def = Object.hasOwn(o.definitions, defId) ? o.definitions[defId] : undefined;
    if (!def) throw new Fail("not_found", 404, `unknown definition ${defId}`);
    const s = await o.settings();
    if (!Object.hasOwn(s.config, defId)) throw new Fail("not_configured", 503, `no config for ${defId}`);
    // One kernel per instance, built once the keys are loaded (Workers can't do crypto at global scope).
    const k = kernel(d, { instance, keys: s.keys, stateKey: s.stateKey });
    // ponytail: definition code shares the isolate; no per-hook timeout or sandbox beyond workerd's limits (managed: #34).
    const bound = bind(def, k, {
      config: s.config[defId],
      // Wrapped: workerd's fetch throws "Illegal invocation" when called as a method of ctx.
      fetch: s.fetch ?? (((...a: Parameters<typeof fetch>) => fetch(...a)) as typeof fetch),
      redirectUri: s.redirectUri,
    }) as Bound;
    const done = k.ticket<string>("session.done", { ttlMs: DONE_TTL_MS });
    const hooks = o.connection.map((f) => f({ k, instance, def, id, bound, settings: s, done }));
    const methods: Record<string, Method> = Object.assign({}, ...hooks.map((h) => h.methods), builtins(bound, hooks, instance, k, done));
    // Timers go to whoever declared them (the lifecycle's refresh, extensions' own).
    const timers = k.serve({});
    return { bound, hooks, methods, timers };
  }

  return (d, instance) => {
    let ready: ReturnType<typeof init> | undefined;
    const get = () => (ready ??= init(d, instance));
    async function after(h: Awaited<ReturnType<typeof init>>, cause: string) {
      for (const x of h?.hooks ?? []) await x.after?.(cause).catch((e) => console.error("after hook", instance, cause, e));
    }

    return {
      async onCall(method, args): Promise<Json> {
        // Kernel-to-kernel (rate scopes on other instances): raw, not a Reply.
        if (method === RATE) return handleRate(d, args);
        let h: Awaited<ReturnType<typeof init>> = null;
        try {
          h = await get();
          if (!h) throw new Fail("not_found", 404, `${instance} is not a connection`);
          if (!Object.hasOwn(h.methods, method)) throw new Fail("bad_request", 400, `unknown method ${method}`);
          return { ok: await (h.methods[method] as Method)(args) };
        } catch (e) {
          return { error: fault(e, instance) };
        } finally {
          await after(h, method);
        }
      },

      async onTimer(name, payload) {
        const h = await get();
        if (!h) return;
        try {
          await h.timers.onTimer(name, payload);
        } finally {
          await after(h, name);
        }
      },
    };
  };
}
