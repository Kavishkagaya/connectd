import type { Driver, Json } from "./driver.ts";
import { type Backoff, backoff } from "./schedule.ts";
import { type Cell, loop, type Value } from "./cell.ts";
import { mutex } from "./sync.ts";

/**
 * Ordered, retried delivery for one instance (#24's outbox, made generic for #53). Promises: nothing
 * lost, in order, at least once (the receiver dedupes on `id`), recent history for status and replay.
 * Per instance, so instances deliver in parallel and a failing receiver blocks only its own line.
 *
 * Storage: a head (`<base>/head`) plus one key per slot (`<base>/e/<n>` the delivery, `<base>/s/<n>`
 * its summary). The head's cas is the commit point: slots in (done, slot] are live, anything past
 * `slot` is an uncommitted write the next add overwrites. Slots and seqs differ: a redelivered copy
 * takes a slot but keeps its original seq, so seqs stay gapless.
 */

/** What `deliver` gets, and the body a receiver sees. `id` and `seq` are the same on every retry. */
export type Delivery<M> = { id: string; seq: number; at: number; msg: M };

export type QueueOptions<M extends Json> = {
  /** Deliver one message. null = delivered; a string = failed, and why (kept for status). A throw counts as a failure. */
  deliver(m: Delivery<M>): Promise<string | null>;
  /** Waits between failed attempts. Retries forever. Default 10 s growing to 1 h. */
  retry?: Pick<Backoff, "baseMs" | "maxMs">;
  /** Waiting cap: past it the oldest are dropped (marked dropped). Default 1000. */
  max?: number;
  /** Done messages kept for status and redeliver. Default 20. */
  keep?: number;
  /** A done message keeps its body only up to this many bytes (else a summary only). Default 64 KB. */
  keepBodyBytes?: number;
  /** The message id. Default `<instance>:<queue>:<seq>`. */
  id?(seq: number): string;
  /** What status lists for a message (no payloads). Default null. */
  summary?(msg: M): Json;
};

export type Summary = {
  slot: number;
  id: string;
  seq: number;
  at: number;
  /** Bytes of the delivery as JSON. */
  size: number;
  /** A redelivered copy of the message with this id. */
  copy: boolean;
  /** When it was delivered; null while waiting, or dropped. */
  deliveredAt: number | null;
  /** Dropped past `max`, never delivered. */
  dropped: boolean;
  summary: Json;
  /** Done and its body kept: `redeliver` can send it. */
  redeliverable: boolean;
};

export type QueueStatus = {
  /** Waiting, head first; the head is the one in flight or parked. */
  pending: number;
  attempt: number;
  /** When a parked head is tried again; null while not parked. */
  retryAt: number | null;
  /** Why the head's last attempt failed. */
  error: string | null;
  /** The first 20 waiting, head first. */
  queued: Summary[];
  /** The `keep` newest done, newest first. */
  recent: Summary[];
};

export class QueueError extends Error {
  constructor(
    readonly code: "pending" | "not_found" | "payload_not_retained",
    message: string,
  ) {
    super(message);
  }
}

export type Queue<M extends Json> = {
  /** Add messages to the end. To keep them after a cell's changes, relay that cell first. */
  push(msgs: M[]): Promise<void>;
  /**
   * Move a cell's outbox messages to the end, exactly once (a crash between the two steps repeats
   * nothing). Takes anything with a cell's `name` and `outbox`, so a caller can reshape the messages.
   */
  relay(c: Pick<Cell<Value, M>, "name" | "outbox">): Promise<void>;
  status(): Promise<QueueStatus>;
  /** Deliver now: skip a parked head's wait (its attempt count stays). */
  flush(): Promise<QueueStatus>;
  /** Send a done message again: a copy at the end with the same id, seq and body. Returns its slot. */
  redeliver(slot: number): Promise<{ slot: number }>;
  /** Arm the drain if anything waits (now, or at a parked head's retry). For a fresh isolate: covers a timer lost in a crash. */
  wake(): Promise<void>;
};

/**
 * `slot` last written, `done` last delivered or dropped, `seq` last message number given out,
 * `relayed` last outbox seq taken per cell, `attempt`/`retryAt`/`error` the head's failures.
 */
type Head = { slot: number; seq: number; done: number; attempt: number; retryAt: number | null; error: string | null; relayed: Record<string, number> };
const EMPTY: Head = { slot: 0, seq: 0, done: 0, attempt: 0, retryAt: null, error: null, relayed: {} };
type Stored = Omit<Summary, "redeliverable">;
type New<M> = { msg: M } | { copy: Delivery<M> };

const QUEUED = 20;
const utf8 = new TextEncoder();

export function queue<M extends Json>(d: Driver, instance: string, name: string, base: string, timerName: string, o: QueueOptions<M>) {
  const max = o.max ?? 1000;
  const keep = o.keep ?? 20;
  const keepBody = o.keepBodyBytes ?? 64 * 1024;
  const retry = { baseMs: 10_000, maxMs: 3_600_000, ...o.retry };
  const idOf = o.id ?? ((seq: number) => `${instance}:${name}:${seq}`);
  const summarize = o.summary ?? (() => null);
  const HEAD = `${base}/head`;
  const ekey = (slot: number) => `${base}/e/${slot}`;
  const skey = (slot: number) => `${base}/s/${slot}`;
  // Appends write keys past `slot` before committing, so two at once would write the same ones.
  const lock = mutex();

  /** Read-decide-cas on the head. Returns the head after and the one it replaced. */
  const change = (f: (h: Head) => Head | null) =>
    loop(d, HEAD, (cur) => {
      const was = (cur?.value as unknown as Head | undefined) ?? EMPTY;
      const now = f(was);
      return now ? { result: { now, was }, write: now as unknown as Json } : { result: { now: was, was } };
    });

  /** Under `lock`: write bodies past `slot`, then commit them with the head's cas. Past `max`, the oldest are dropped. */
  async function append(add: (head: Head) => { items: New<M>[]; relayed?: [string, number] } | null): Promise<Head> {
    const { now: head } = await change(() => null);
    const a = add(head);
    if (!a) return head;
    let seq = head.seq;
    for (const [i, n] of a.items.entries()) {
      const slot = head.slot + i + 1;
      const e: Delivery<M> = "copy" in n ? n.copy : { id: idOf(++seq), seq, at: d.now(), msg: n.msg };
      await d.store.put(ekey(slot), e as unknown as Json);
      const s: Stored = { slot, id: e.id, seq: e.seq, at: e.at, size: utf8.encode(JSON.stringify(e)).length, copy: "copy" in n, deliveredAt: null, dropped: false, summary: summarize(e.msg) };
      await d.store.put(skey(slot), s as unknown as Json);
    }
    const slot = head.slot + a.items.length;
    const r = await change((cur) => {
      // Delivery only moves done/attempt/retryAt/error; slot, seq and relayed are ours while locked.
      if (cur.slot !== head.slot) throw new Error(`queue ${name}: concurrent append`);
      return { ...cur, slot, seq, done: Math.max(cur.done, slot - max), relayed: a.relayed ? { ...cur.relayed, [a.relayed[0]]: a.relayed[1] } : cur.relayed };
    });
    await finish(r.was.done, r.now.done, null);
    return r.now;
  }

  /**
   * `done` moved from `from` to `to` (delivered at `at`, or dropped: null). Slots that fell out of the
   * `keep` newest are freed; newly done ones keep their summary, and their body only if small.
   * Not atomic with the head's cas: a crash here leaves a stale summary or garbage never read again.
   */
  async function finish(from: number, to: number, at: number | null) {
    for (let s = Math.max(0, from - keep) + 1; s <= to - keep; s++) {
      await d.store.delete(ekey(s));
      await d.store.delete(skey(s));
    }
    for (let s = Math.max(from, to - keep) + 1; s <= to; s++) {
      const k = (await d.store.get(skey(s)))?.value as unknown as Stored | undefined;
      if (k) await d.store.put(skey(s), { ...k, deliveredAt: at, dropped: at === null } as unknown as Json);
      if (!k || k.size > keepBody) await d.store.delete(ekey(s));
    }
  }

  /** Wake the drain: now, or when a parked head may retry. */
  async function arm() {
    const { now: head } = await change(() => null);
    if (head.slot > head.done) await d.timer.set(timerName, Math.max(d.now(), head.retryAt ?? 0));
  }

  async function attempt(e: Delivery<M>): Promise<string | null> {
    try {
      return await o.deliver(e);
    } catch (err) {
      console.error("queue deliver threw", instance, name, e.id, err);
      return err instanceof Error ? err.message : String(err);
    }
  }

  /** From the queue's timer only (timers don't overlap per instance): one message in flight, in order. */
  async function drain() {
    for (;;) {
      const { now: head } = await change(() => null);
      if (head.done >= head.slot) return;
      // Woken early (an arm raced a failure): keep the wait.
      if (head.retryAt !== null && d.now() < head.retryAt) return d.timer.set(timerName, head.retryAt);
      const next = head.done + 1;
      const e = (await d.store.get(ekey(next)))?.value as unknown as Delivery<M> | undefined;
      // Missing only if an append dropped it past `max` since we read the head; read again.
      if (!e) continue;
      const error = await attempt(e);
      if (error === null) {
        const r = await change((cur) => ({ ...cur, done: Math.max(cur.done, next), attempt: 0, retryAt: null, error: null }));
        await finish(r.was.done, r.now.done, d.now());
        continue;
      }
      const at = d.now() + backoff(head.attempt, retry);
      await change((cur) => ({ ...cur, attempt: cur.attempt + 1, retryAt: at, error }));
      // Not atomic with the cas: if this is lost, the next push, relay or flush arms from `retryAt`.
      return d.timer.set(timerName, at);
    }
  }

  async function status(): Promise<QueueStatus> {
    const { now: head } = await change(() => null);
    const read = async (from: number, to: number) => {
      const out: Summary[] = [];
      for (let s = from; s <= to; s++) {
        const k = (await d.store.get(skey(s)))?.value as unknown as Stored | undefined;
        if (k) out.push({ ...k, redeliverable: s <= head.done && k.size <= keepBody });
      }
      return out;
    };
    return {
      pending: head.slot - head.done,
      attempt: head.attempt,
      retryAt: head.retryAt,
      error: head.error,
      queued: await read(head.done + 1, Math.min(head.slot, head.done + QUEUED)),
      recent: (await read(Math.max(1, head.done - keep + 1), head.done)).reverse(),
    };
  }

  const q: Queue<M> = {
    async push(msgs) {
      if (!msgs.length) return;
      await lock.run(() => append(() => ({ items: msgs.map((msg) => ({ msg })) })));
      await arm();
    },
    async relay(c) {
      const waiting = await c.outbox.pending();
      if (!waiting.length) return;
      const head = await lock.run(() =>
        append((h) => {
          const fresh = waiting.filter((i) => i.seq > (h.relayed[c.name] ?? 0));
          const last = fresh.at(-1);
          return last ? { items: fresh.map((i) => ({ msg: i.msg })), relayed: [c.name, last.seq] } : null;
        }),
      );
      // `relayed` committed with the messages, so a crash before this ack only repeats the ack.
      await c.outbox.ack(head.relayed[c.name] ?? 0);
      await arm();
    },
    status,
    async flush() {
      await change((cur) => (cur.retryAt === null ? null : { ...cur, retryAt: null }));
      await arm();
      return status();
    },
    async redeliver(slot) {
      const head = await lock.run(async () => {
        const { now: cur } = await change(() => null);
        if (slot > cur.done) throw new QueueError("pending", "that message hasn't been delivered yet");
        const k = slot > cur.done - keep && slot >= 1 ? ((await d.store.get(skey(slot)))?.value as unknown as Stored | undefined) : undefined;
        if (!k) throw new QueueError("not_found", `only the ${keep} newest done messages are kept`);
        const e = (await d.store.get(ekey(slot)))?.value as unknown as Delivery<M> | undefined;
        if (!e) throw new QueueError("payload_not_retained", `its body wasn't kept: done messages keep theirs up to ${keepBody} bytes`);
        return append(() => ({ items: [{ copy: e }] }));
      });
      await arm();
      return { slot: head.slot };
    },
    wake: arm,
  };
  return { queue: q, drain };
}
