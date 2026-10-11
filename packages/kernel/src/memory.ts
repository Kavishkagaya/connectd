import type { Driver, Handler, Json, Program } from "./index.ts";

type Entry = { v: number; value: Json; expiresAt?: number };
type Timer = { at: number; payload: Json };

// ponytail: no serialization queue on purpose. Durable Objects interleave at awaits too,
// so tests here catch the races the DO driver would hit.
export function memory(program: Program, opts: { now?: number } = {}) {
  let now = opts.now ?? 0;
  const instances = new Map<string, { handler: Handler; store: Map<string, Entry>; timers: Map<string, Timer> }>();

  const get = (id: string) => {
    let inst = instances.get(id);
    if (!inst) {
      const store = new Map<string, Entry>();
      const timers = new Map<string, Timer>();
      const live = (key: string) => {
        const e = store.get(key);
        if (e?.expiresAt !== undefined && e.expiresAt <= now) {
          store.delete(key);
          return undefined;
        }
        return e;
      };
      const write = (key: string, value: Json, ttlMs?: number) => {
        store.set(key, {
          v: (live(key)?.v ?? 0) + 1,
          value: structuredClone(value),
          expiresAt: ttlMs === undefined ? undefined : now + ttlMs,
        });
      };
      const driver: Driver = {
        now: () => now,
        store: {
          async get(key) {
            const e = live(key);
            return e ? { v: e.v, value: structuredClone(e.value) } : null;
          },
          async put(key, value, o) {
            write(key, value, o?.ttlMs);
          },
          async cas(key, expected, value, o) {
            if ((live(key)?.v ?? null) !== expected) return false;
            write(key, value, o?.ttlMs);
            return true;
          },
          async take(key) {
            const e = live(key);
            store.delete(key);
            return e ? e.value : null;
          },
          async delete(key) {
            store.delete(key);
          },
        },
        timer: {
          async set(name, at, payload = null) {
            timers.set(name, { at, payload: structuredClone(payload) });
          },
          async cancel(name) {
            timers.delete(name);
          },
        },
        call: (instance, method, args) => call(instance, method, args),
      };
      inst = { handler: program(driver, id), store, timers };
      instances.set(id, inst);
    }
    return inst;
  };

  const call = async (instance: string, method: string, args: Json) =>
    structuredClone(await get(instance).handler.onCall(method, structuredClone(args)));

  return {
    call,
    now: () => now,
    /** Move the fake clock forward, firing due timers in time order. */
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        let next: { id: string; name: string; t: Timer } | undefined;
        for (const [id, inst] of instances)
          for (const [name, t] of inst.timers)
            if (t.at <= target && (!next || t.at < next.t.at)) next = { id, name, t };
        if (!next) break;
        now = Math.max(now, next.t.at);
        instances.get(next.id)?.timers.delete(next.name);
        await instances.get(next.id)?.handler.onTimer(next.name, next.t.payload);
      }
      now = target;
    },
  };
}
