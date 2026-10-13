import type { Driver, Handler, Json, Program } from "../driver.ts";

type Entry = { v: number; value: Json; expiresAt?: number };
type Timer = { at: number; payload: Json };
type Instance = { handler: Handler; seq: number; store: Map<string, Entry>; timers: Map<string, Timer> };

/** Everything the driver holds (store, versions, timers), as JSON: `dump()` writes it, `opts.snapshot` restores it. */
export type Snapshot = Record<string, { seq: number; store: Record<string, Entry>; timers: Record<string, Timer> }>;

export type MemoryOptions = {
  /** Start of the fake clock. */
  now?: number;
  /**
   * A real clock instead (`Date.now`, for `openconnect dev`): `now()` follows it and timers fire on
   * their own when due. `advance(ms)` still works on top, as a skew.
   */
  clock?: () => number;
  /** Restore a `dump()`: a restart that keeps state, versions and timers, as a DO would. */
  snapshot?: Snapshot;
};

// ponytail: no serialization queue on purpose. Durable Objects interleave at awaits too,
// so tests here catch the races the DO driver would hit.
export function memory(program: Program, opts: MemoryOptions = {}) {
  const start = opts.now ?? 0;
  const clock = opts.clock ?? (() => start);
  let skew = 0;
  const now = () => clock() + skew;
  const instances = new Map<string, Instance>();

  const get = (id: string) => {
    let inst = instances.get(id);
    if (!inst) {
      const saved = opts.snapshot?.[id];
      const self: Instance = {
        handler: null as unknown as Handler,
        seq: saved?.seq ?? 0, // versions never repeat, even after delete (no ABA on cas)
        store: new Map(Object.entries(structuredClone(saved?.store ?? {}))),
        timers: new Map(Object.entries(structuredClone(saved?.timers ?? {}))),
      };
      const { store, timers } = self;
      const live = (key: string) => {
        const e = store.get(key);
        if (e?.expiresAt !== undefined && e.expiresAt <= now()) {
          store.delete(key);
          return undefined;
        }
        return e;
      };
      const write = (key: string, value: Json, ttlMs?: number) => {
        store.set(key, { v: ++self.seq, value: structuredClone(value), ...(ttlMs === undefined ? {} : { expiresAt: now() + ttlMs }) });
      };
      const driver: Driver = {
        now,
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
            schedule();
          },
          async cancel(name) {
            timers.delete(name);
            schedule();
          },
        },
        call: (instance, method, args) => call(instance, method, args),
      };
      instances.set(id, self);
      self.handler = program(driver, id);
      inst = self;
    }
    return inst;
  };

  const call = async (instance: string, method: string, args: Json) =>
    structuredClone(await get(instance).handler.onCall(method, structuredClone(args)));

  // Fire due timers earliest first (removed before firing). One run at a time, so timers never overlap.
  let firing = Promise.resolve();
  const fire = () =>
    (firing = firing.then(async () => {
      for (;;) {
        let next: { inst: Instance; name: string; t: Timer } | undefined;
        for (const inst of instances.values())
          for (const [name, t] of inst.timers) if (t.at <= now() && (!next || t.at < next.t.at)) next = { inst, name, t };
        if (!next) break;
        next.inst.timers.delete(next.name);
        const { inst, name, t } = next;
        // Through a promise, so a handler that throws synchronously is logged like a rejection and the chain goes on.
        await Promise.resolve()
          .then(() => inst.handler.onTimer(name, t.payload))
          .catch((e) => console.error("timer", name, e));
      }
      schedule();
    }));

  // Real clock only: one wall-clock timeout for the earliest timer of any instance.
  let pending: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  function schedule() {
    if (!opts.clock || stopped) return;
    clearTimeout(pending);
    let at = Infinity;
    for (const inst of instances.values()) for (const t of inst.timers.values()) at = Math.min(at, t.at);
    if (at === Infinity) return;
    pending = setTimeout(fire, Math.min(Math.max(at - now(), 0), 2 ** 31 - 1));
    // Unref'd: pending timers don't keep a process alive (a dev server saves them in its snapshot).
    (pending as { unref?: () => void }).unref?.();
  }

  // A restored instance's timers must be found without waiting for its first call.
  for (const id of Object.keys(opts.snapshot ?? {})) get(id);
  schedule();

  return {
    call,
    now,
    /** Move the clock forward, then fire due timers earliest first (removed before firing). */
    async advance(ms: number) {
      skew += ms;
      await fire();
    },
    /** Real clock: stop firing timers on their own (they stay stored, for `dump()`), after any timer still running. */
    async stop() {
      stopped = true;
      clearTimeout(pending);
      await firing;
    },
    /** All state as JSON, for `opts.snapshot`. Instances that never wrote and have no timers are left out. */
    dump(): Snapshot {
      const out: Snapshot = {};
      for (const [id, i] of instances)
        if (i.seq || i.timers.size) out[id] = structuredClone({ seq: i.seq, store: Object.fromEntries(i.store), timers: Object.fromEntries(i.timers) });
      return out;
    },
  };
}
