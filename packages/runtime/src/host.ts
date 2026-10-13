import { bind, type Definition, InputError } from "@openconnect/connections";
import { type Driver, handleRate, IllegalTransition, type Json, type Keys, NotActive, OAuthError, type Program, RATE } from "@openconnect/kernel";

/**
 * The connection host: one Program that runs any definition from a registry, one instance per
 * connection. Definition code only ever sees its `ctx` (config, fetch, redirectUri, now), never the
 * driver; the kernel owns the record, so a hook that throws can't leave it half-written.
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
};

export type Fault = { code: string; status: number; message: string; state?: string; reason?: string };
/** Every connection method replies with this; error classes don't survive a DO RPC, so faults are data. */
export type Reply = { ok: Json } | { error: Fault };
export type Method = (args: Json) => Promise<Json>;

/** What an extension sees of one hosted connection. */
export type Hosted = { d: Driver; instance: string; def: AnyDefinition; id: string; bound: Bound; settings: Settings };

/** An extension's per-connection part. Created once per instance, next to `bind`. */
export type Hooks = {
  /** Extra methods, reachable by RPC and by `POST /connections/:def/:id/:method`. Built-ins win on a name clash. */
  methods?: Record<string, Method>;
  /** True if the timer was this extension's. Name timers `<extension>.<name>`; `kernel.*` is taken. */
  onTimer?(name: string, payload: Json): Promise<boolean>;
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
  ) {
    super(message);
  }
}

/** Connection instance key. The definition id is part of it, so a DO knows what to run with no lookup. */
export const instanceOf = (def: string, id: string) => `conn:${def}:${id}`;

export function fault(e: unknown, instance: string): Fault {
  if (e instanceof Fail) return { code: e.code, status: e.status, message: e.message };
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

const builtins = (b: Bound, hooks: Hooks[], instance: string): Record<string, Method> => ({
  connect: async (a) => ({ url: await b.connect(input(a)) }),
  callback: async (a) => {
    await b.callback(input(a));
    return status(b);
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
    // ponytail: other instances (app-scope rate keys) only answer RATE; give them hooks when an extension needs one.
    if (!m) return null;
    const [, defId, id] = m as unknown as [string, string, string];
    const def = Object.hasOwn(o.definitions, defId) ? o.definitions[defId] : undefined;
    if (!def) throw new Fail("not_found", 404, `unknown definition ${defId}`);
    const s = await o.settings();
    if (!Object.hasOwn(s.config, defId)) throw new Fail("not_configured", 503, `no config for ${defId}`);
    // ponytail: definition code shares the isolate; no per-hook timeout or sandbox beyond workerd's limits (managed: #34).
    const bound = bind(def, d, instance, {
      config: s.config[defId],
      // Wrapped: workerd's fetch throws "Illegal invocation" when called as a method of ctx.
      fetch: s.fetch ?? (((...a: Parameters<typeof fetch>) => fetch(...a)) as typeof fetch),
      redirectUri: s.redirectUri,
      keys: s.keys,
      stateKey: s.stateKey,
    }) as Bound;
    const hooks = o.connection.map((f) => f({ d, instance, def, id, bound, settings: s }));
    const methods: Record<string, Method> = Object.assign({}, ...hooks.map((h) => h.methods), builtins(bound, hooks, instance));
    return { bound, hooks, methods };
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
          if (await h.bound.onTimer(name, payload)) return;
          for (const x of h.hooks) if (await x.onTimer?.(name, payload)) return;
          console.error("unhandled timer", instance, name);
        } finally {
          await after(h, name);
        }
      },
    };
  };
}
