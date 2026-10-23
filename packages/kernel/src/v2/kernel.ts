import type { Driver, Handler, Json } from "../driver.ts";
import { decrypt, encrypt, type Keys, keyVersion } from "../primitives/secrets.ts";
import { type Cell, cell, type Value } from "./cell.ts";
import { acquire, type Limit, type Limiter, limiter, RATE, rate, rateKey, refund } from "./limiter.ts";
import { type Queue, type QueueOptions, queue } from "./queue.ts";
import { flight, flights, mutex } from "./sync.ts";
import { type Ticket, ticket } from "./ticket.ts";
import { type Timer, type TimerOptions, timer } from "./timer.ts";

/**
 * The kernel (#53): the management layer of one instance. Mechanism only: it knows how to store,
 * update, retry and deliver safely, never what a connection, a token or a provider is.
 *
 *   const program: Program = (driver, instance) => {
 *     const k = kernel(driver, { instance, keys, stateKey });
 *     const record = k.cell<Record, Msg>("record");     // declare once…
 *     const refresh = k.flight<Credential>();
 *     return k.serve({ token: … });                     // …use the handles in methods
 *   };
 *
 * Create one per Program call: in-memory tools (flight, mutex) live in it. Stored tools take a
 * stable name (saved, so it must match after a restart), declared once per instance: a second
 * declaration of the same name throws.
 */

export type KernelOptions = {
  instance: string;
  /** For `seal` / `unseal`. */
  keys?: Keys;
  /** For tickets. */
  stateKey?: CryptoKey;
};

export type Method = (args: Json) => Promise<Json>;

/** Letters, digits, `_ . -`: no `:` or `/`, which the kernel uses to build its own keys. */
const NAME = /^[A-Za-z0-9_.-]+$/;

export function kernel(d: Driver, o: KernelOptions) {
  const { instance } = o;
  const claimed = new Set<string>();
  /** Timer name → what runs when the driver fires it. `serve` routes `onTimer` here. */
  const fires = new Map<string, (payload: Json) => Promise<void>>();

  function claim(kind: string, name: string) {
    if (!NAME.test(name)) throw new Error(`kernel: bad ${kind} name ${JSON.stringify(name)} (letters, digits, _ . - only)`);
    const k = `${kind}:${name}`;
    if (claimed.has(k)) throw new Error(`kernel: ${kind} ${name} declared twice in ${instance}`);
    claimed.add(k);
  }
  function need<T>(v: T | undefined, what: "keys" | "stateKey"): T {
    if (v === undefined) throw new Error(`kernel: needs opts.${what}`);
    return v;
  }

  const lim = Object.assign(
    /** A limiter stored in this instance. */
    (name: string, limit: Limit): Limiter => {
      claim("limiter", name);
      return limiter(d, instance, instance, name, limit);
    },
    {
      /** A limiter stored in another instance (an app-wide scope), reached with `driver.call`. */
      at: (other: string, name: string, limit: Limit): Limiter => limiter(d, instance, other, name, limit),
    },
  );

  return {
    instance,
    now: () => d.now(),

    /** A value with safe updates and an outbox. */
    cell<V extends Value, M extends Json = never>(name: string, opts: { ttlMs?: number } = {}): Cell<V, M> {
      claim("cell", name);
      return cell<V, M>(d, `c:${name}`, name, opts);
    },

    /** Single-flight: callers at the same time share one run. In memory, no name. */
    flight,
    /** Single-flight per key. */
    flights,
    /** One at a time, in arrival order. In memory, no name. */
    mutex,

    /** A named alarm and its handler; `throw` in the handler means retry (with `retry`). */
    timer<P extends Json = null>(name: string, opts: TimerOptions<P>): Timer<P> {
      claim("timer", name);
      const t = timer<P>(d, instance, name, opts);
      fires.set(name, t.fire);
      return t.timer;
    },

    /** Ordered, retried delivery with history. Its drain runs from its own timer (`q:<name>`). */
    queue<M extends Json>(name: string, opts: QueueOptions<M>): Queue<M> {
      claim("queue", name);
      const t = `q:${name}`;
      const q = queue<M>(d, instance, name, t, t, opts);
      fires.set(t, () => q.drain());
      return q.queue;
    },

    /** A signed, one-time, expiring pass whose data stays here. */
    ticket<D extends Json>(name: string, opts: { ttlMs: number }): Ticket<D> {
      claim("ticket", name);
      return ticket<D>(d, instance, name, (id) => `t:${name}/${id}`, need(o.stateKey, "stateKey"), opts.ttlMs);
    },

    /** Permits (GCRA). `k.limiter.at(instance, …)` for one stored elsewhere. */
    limiter: lim,
    /** Take a permit from every limiter, all or nothing. */
    acquire,
    /** Give permits back. */
    refund,

    /** Encrypt under the current key version. */
    seal: async (value: Json) => encrypt(JSON.stringify(value), need(o.keys, "keys")),
    /** Decrypt; `stale` = sealed under an older key version (seal it again with the next update). */
    async unseal<T extends Json>(sealed: string): Promise<{ value: T; stale: boolean }> {
      const keys = need(o.keys, "keys");
      return { value: JSON.parse(await decrypt(sealed, keys)) as T, stale: keyVersion(sealed) !== keys.current };
    },

    /**
     * The driver's Handler: `kernel.rate` (another instance using a limiter stored here) goes to the
     * limiter, other `kernel.*` methods are refused, the rest go to `methods`; timers go to the
     * handler declared under their name. Keeping `kernel.*` away from outside callers is the front
     * desk's job (the HTTP layer refuses them).
     */
    serve(methods: Record<string, Method>): Handler {
      return {
        async onCall(method, args) {
          if (method === RATE) return rate(d, args);
          if (method.startsWith("kernel.")) throw new Error(`kernel: no method ${method}`);
          const m = Object.hasOwn(methods, method) ? methods[method] : undefined;
          if (!m) throw new Error(`no method ${method} on ${instance}`);
          return m(args);
        },
        async onTimer(name, payload) {
          const f = fires.get(name);
          // ponytail: an alarm left by older code (a renamed timer) is dropped with a warning.
          if (!f) return console.warn("kernel: no handler for timer", instance, name);
          await f(payload);
        },
      };
    },
  };
}

export type Kernel = ReturnType<typeof kernel>;
export { rateKey };
