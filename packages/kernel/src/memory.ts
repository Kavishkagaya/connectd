import type { Driver, Handler, Json, Program } from "./index.ts";

type Entry = { v: number; value: Json; expiresAt?: number };
type Timer = { at: number; payload: Json };

// ponytail: no serialization queue on purpose. Durable Objects interleave at awaits too,
// so tests here catch the races the DO driver would hit.
export function memory(program: Program, opts: { now?: number } = {}) {
  let now = opts.now ?? 0;
  const instances = new Map<string, { handler: Handler; timers: Map<string, Timer> }>();

  const get = (id: string) => {
    let inst = instances.get(id);
    if (!inst) {
      const store = new Map<string, Entry>();
      const timers = new Map<string, Timer>();
      let seq = 0; // versions never repeat, even after delete (no ABA on cas)
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
          v: ++seq,
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
      inst = { handler: program(driver, id), timers };
      instances.set(id, inst);
    }
    return inst;
  };

  const call = async (instance: string, method: string, args: Json) =>
    structuredClone(await get(instance).handler.onCall(method, structuredClone(args)));

  return {
    call,
    now: () => now,
    /** Move the fake clock forward, then fire due timers earliest first (removed before firing). */
    async advance(ms: number) {
      now += ms;
      for (;;) {
        let next: { inst: { handler: Handler; timers: Map<string, Timer> }; name: string; t: Timer } | undefined;
        for (const inst of instances.values())
          for (const [name, t] of inst.timers) if (t.at <= now && (!next || t.at < next.t.at)) next = { inst, name, t };
        if (!next) return;
        next.inst.timers.delete(next.name);
        await next.inst.handler.onTimer(next.name, next.t.payload).catch((e) => console.error("timer", next.name, e));
      }
    },
  };
}
