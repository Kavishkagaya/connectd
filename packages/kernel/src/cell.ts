import type { Atom, Json } from "./platform.ts";

/** A stored value. `null` is reserved: it means "absent" on read and "no change" from `update`. */
export type Value = Exclude<Json, null>;

/** One step of a read-decide-cas loop: write `write` (if present) only if nobody wrote since the read. */
type Step<T> = { result: T } | { result: T; write: Json; ttlMs?: number };

/** Read, decide, cas, until it lands. Every safe update in the kernel goes through here. */
export async function loop<T>(d: Atom, key: string, f: (cur: { v: number; value: Json } | null) => Step<T>): Promise<T> {
  for (;;) {
    const cur = await d.store.get(key);
    const s = f(cur);
    if (!("write" in s)) return s.result;
    if (await d.store.cas(key, cur?.v ?? null, s.write, s.ttlMs === undefined ? undefined : { ttlMs: s.ttlMs })) return s.result;
  }
}

/** A message waiting in a cell's outbox: `seq` counts up with no gaps over the cell's life. */
export type Item<M> = { seq: number; msg: M };
type Envelope = { data: Json; out?: { seq: number; items: Item<Json>[] } };

/** Kept in the outbox if nothing relays it. ponytail: the oldest go past this (a gap in seq shows it). */
const MAX_OUT = 100;

export type Cell<V extends Value, M extends Json = never> = {
  readonly name: string;
  /** The value and its version (changes on every write), or null if never written. */
  read(): Promise<{ value: V; v: number } | null>;
  /**
   * Read → `f` decides → cas → retry until it lands. `f` returns the new value, or null for no
   * change. It must be synchronous and only decide: it runs again on fresh data when another write
   * got in first. Messages given to `emit` are saved in the same write (only the attempt that lands
   * counts). A throw writes nothing. Returns the value after.
   */
  update(f: (cur: V | null, emit: (msg: M) => void) => V | null): Promise<V | null>;
  /** Set it, whatever it was (the outbox is kept). */
  put(value: V): Promise<void>;
  /** Remove it, outbox included. */
  delete(): Promise<void>;
  /** Read and remove in one step: of callers racing for it, one gets the value, the others null. */
  take(): Promise<V | null>;
  /** For `queue.relay`: the messages waiting, oldest first, and dropping them once taken. */
  outbox: { pending(): Promise<Item<M>[]>; ack(seq: number): Promise<void> };
};

export function cell<V extends Value, M extends Json = never>(d: Atom, key: string, name: string, opts: { ttlMs?: number } = {}): Cell<V, M> {
  const ttl = opts.ttlMs === undefined ? {} : { ttlMs: opts.ttlMs };
  const env = (cur: { value: Json } | null) => (cur?.value ?? null) as unknown as Envelope | null;

  const c: Cell<V, M> = {
    name,
    async read() {
      const r = await d.store.get(key);
      return r ? { value: (r.value as unknown as Envelope).data as V, v: r.v } : null;
    },
    update(f) {
      return loop(d, key, (cur) => {
        const e = env(cur);
        const msgs: M[] = [];
        const next = f((e?.data ?? null) as V | null, (m) => void msgs.push(m));
        if (next !== null && typeof (next as { then?: unknown }).then === "function") throw new TypeError(`cell ${name}: update's f must be synchronous`);
        if (next === null) return { result: (e?.data ?? null) as V | null };
        let out = e?.out;
        if (msgs.length) {
          const seq = out?.seq ?? 0;
          const items = [...(out?.items ?? []), ...msgs.map((msg, i) => ({ seq: seq + i + 1, msg: msg as Json }))].slice(-MAX_OUT);
          out = { seq: seq + msgs.length, items };
        }
        const write: Envelope = { data: next, ...(out ? { out } : {}) };
        return { result: next, write: write as unknown as Json, ...ttl };
      });
    },
    async put(value) {
      await c.update(() => value);
    },
    delete: () => d.store.delete(key),
    async take() {
      return ((env({ value: await d.store.take(key) })?.data ?? null) as V | null);
    },
    outbox: {
      async pending() {
        return (env(await d.store.get(key))?.out?.items ?? []) as Item<M>[];
      },
      ack: (seq) =>
        loop(d, key, (cur) => {
          const e = env(cur);
          if (!e?.out?.items.some((i) => i.seq <= seq)) return { result: undefined };
          const write: Envelope = { ...e, out: { seq: e.out.seq, items: e.out.items.filter((i) => i.seq > seq) } };
          return { result: undefined, write: write as unknown as Json, ...ttl };
        }),
    },
  };
  return c;
}
