import {
  after,
  allPages,
  type Atom,
  type ConnectionRow,
  type Handler,
  type Json,
  type Level,
  LIMITS,
  type Limits,
  type Management,
  PAGE,
  page,
  type Platform,
  type Program,
  Unavailable,
  within,
} from "../platform.ts";

export { LIMITS };

type Entry = { v: number; value: Json; expiresAt?: number };
type Timer = { at: number; payload: Json };
type Instance = { handler: Handler; seq: number; store: Map<string, Entry>; timers: Map<string, Timer> };

/** Every atom's store, versions and timers, as JSON: `dump()` writes it, `opts.snapshot` restores it. */
export type Snapshot = Record<string, { seq: number; store: Record<string, Entry>; timers: Record<string, Timer> }>;


export type MemoryOptions = {
  /** Start of the fake clock. */
  now?: number;
  /**
   * A real clock instead (`Date.now`, for `connectd dev`): `now()` follows it and timers fire on
   * their own when due. `advance(ms)` still works on top, as a skew.
   */
  clock?: () => number;
  /** Restore a `dump()`: a restart that keeps state, versions and timers, as a DO would. */
  snapshot?: Snapshot;
  /** Default `dev`. */
  version?: string;
  /** What `platform.env` reads: values, or a lookup (dev's, which follows `.env` across reloads). Default: nothing set. */
  env?: Record<string, string | undefined> | ((name: string) => string | undefined);
  /** Outbound HTTP. Default: the global fetch. */
  fetch?: Platform["fetch"];
  /** Default: the console, by level. */
  log?: Platform["log"];
  /** Default `LIMITS`. */
  limits?: Limits;
  /** The management database. Default: a fresh `memoryDb()` (tests wrap one to inject failures). */
  db?: Management;
};

const toConsole = (level: Level, event: string, fields?: Record<string, Json>) => console[level](event, fields ?? {});

/**
 * The memory platform: tests (fake clock) and `connectd dev` (real clock). Atoms live in maps; the
 * management database too.
 * ponytail: no serialization queue on purpose. Durable Objects interleave at awaits too, so tests
 * here catch the races the DO platform would hit.
 */
export function memory(program: Program, opts: MemoryOptions = {}) {
  const start = opts.now ?? 0;
  const clock = opts.clock ?? (() => start);
  let skew = 0;
  const now = () => clock() + skew;
  const limits = opts.limits ?? LIMITS;
  const log = opts.log ?? toConsole;
  const instances = new Map<string, Instance>();
  /** Fault injection: calls to these atoms throw `Unavailable`, as an unreachable DO would. */
  const unreachable = new Set<string>();
  const deferred = new Set<Promise<unknown>>();

  const platform: Platform = {
    version: opts.version ?? "dev",
    now,
    env: (name) => {
      const e = opts.env;
      return typeof e === "function" ? e(name) : e && Object.hasOwn(e, name) ? e[name] : undefined;
    },
    fetch: opts.fetch ?? ((input, init) => fetch(input, init)),
    log,
    defer(work) {
      const p = work.catch((e) => log("error", "platform.defer.failed", { error: e instanceof Error ? e.message : String(e) })).finally(() => deferred.delete(p));
      deferred.add(p);
    },
    atoms: {
      async call(name, method, args) {
        within("call args", args, limits.callBytes);
        if (unreachable.has(name)) throw new Unavailable(`atom ${name} is unreachable`);
        const out = await get(name).handler.onCall(method, structuredClone(args));
        within("call result", out, limits.callBytes);
        return structuredClone(out);
      },
      async destroy(name) {
        const inst = instances.get(name);
        if (!inst) return;
        // The version counter stays: versions never repeat, even across a destroy.
        inst.store.clear();
        inst.timers.clear();
        inst.handler = program(atomOf(name, inst), platform);
      },
    },
    db: opts.db ?? memoryDb(),
    limits,
  };

  function atomOf(name: string, self: Instance): Atom {
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
      within(`value ${key}`, value, limits.valueBytes);
      store.set(key, { v: ++self.seq, value: structuredClone(value), ...(ttlMs === undefined ? {} : { expiresAt: now() + ttlMs }) });
    };
    return {
      name,
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
        async set(timer, at, payload = null) {
          within(`timer ${timer} payload`, payload, limits.valueBytes);
          timers.set(timer, { at, payload: structuredClone(payload) });
          schedule();
        },
        async cancel(timer) {
          timers.delete(timer);
          schedule();
        },
      },
    };
  }

  function get(name: string) {
    let inst = instances.get(name);
    if (!inst) {
      const saved = opts.snapshot?.[name];
      const self: Instance = {
        handler: null as unknown as Handler,
        seq: saved?.seq ?? 0, // versions never repeat, even after delete (no ABA on cas)
        store: new Map(Object.entries(structuredClone(saved?.store ?? {}))),
        timers: new Map(Object.entries(structuredClone(saved?.timers ?? {}))),
      };
      instances.set(name, self);
      self.handler = program(atomOf(name, self), platform);
      inst = self;
    }
    return inst;
  }

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
          .catch((e) => log("error", "platform.timer.threw", { timer: name, error: e instanceof Error ? e.message : String(e) }));
      }
      schedule();
    }));

  // Real clock only: one wall-clock timeout for the earliest timer of any atom.
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

  // A restored atom's timers must be found without waiting for its first call.
  for (const name of Object.keys(opts.snapshot ?? {})) get(name);
  schedule();

  return {
    platform,
    /** `platform.atoms.call`. */
    call: platform.atoms.call,
    now,
    /** Calls to these atoms throw `Unavailable` until removed. */
    unreachable,
    /** Move the clock forward, then fire due timers earliest first (removed before firing). */
    async advance(ms: number) {
      skew += ms;
      await fire();
    },
    /** Wait for work handed to `platform.defer`, including work it defers in turn. */
    async settle() {
      while (deferred.size) await Promise.all(deferred);
    },
    /** Real clock: stop firing timers on their own (they stay stored, for `dump()`), after any timer still running. */
    async stop() {
      stopped = true;
      clearTimeout(pending);
      await firing;
    },
    /** Every atom's state as JSON, for `opts.snapshot`. Atoms that never wrote and have no timers are left out. The database isn't in it. */
    dump(): Snapshot {
      const out: Snapshot = {};
      for (const [id, i] of instances)
        if (i.seq || i.timers.size) out[id] = structuredClone({ seq: i.seq, store: Object.fromEntries(i.store), timers: Object.fromEntries(i.timers) });
      return out;
    },
  };
}

/** The management database in maps. */
export function memoryDb(): Management {
  const conns = new Map<string, ConnectionRow>();
  const key = (def: string, id: string) => JSON.stringify([def, id]);
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const list: Management["connections"]["list"] = async (q) => {
    const from = q.cursor ? after(q.cursor) : null;
    const needle = q.q?.toLowerCase();
    const hits = [...conns.values()]
      .filter(
        (r) =>
          (!q.def || r.def === q.def) &&
          (!q.state || r.state === q.state) &&
          (!q.external || (Object.hasOwn(r.external, q.external.key) && r.external[q.external.key] === q.external.value)) &&
          (!needle || [r.id, ...Object.values(r.external)].some((s) => s.toLowerCase().includes(needle))) &&
          (!from || cmp(r.def, from[0]) > 0 || (r.def === from[0] && cmp(r.id, from[1]) > 0)),
      )
      .sort((a, b) => cmp(a.def, b.def) || cmp(a.id, b.id));
    return page(structuredClone(hits.slice(0, (q.limit ?? PAGE) + 1)), q);
  };
  return {
    connections: {
      async upsert(r) {
        const cur = conns.get(key(r.def, r.id));
        // Equal versions carry equal data, so they rewrite (that's how `index.sync` repairs a row).
        if (cur && cur.version > r.version) return;
        conns.set(key(r.def, r.id), structuredClone({ ...r, createdAt: cur?.createdAt ?? r.updatedAt }));
      },
      list,
      byExternal: (def, k, value) => allPages(list, { def, external: { key: k, value } }),
    },
  };
}
