import { backoff, type Driver, type Json, type State } from "@openconnect/kernel";
import type { Hosted } from "./host.ts";
import type { Extension } from "./runtime.ts";
import { sign } from "./signature.ts";
import type { WebhookData } from "./webhooks.ts";

/**
 * Event delivery to the user's server: POST, signed (Standard Webhooks, see signature.ts),
 * at least once, in order per connection. Each connection drains its own outbox, one event at a
 * time, from its durable `events.retry` timer; a failure parks the outbox until the next attempt.
 *
 * Storage: one key per event (`events.e:<seq>`) plus a small head record (`events.head`). The
 * head's `cas` is the commit point: events in (done, seq] are live; anything else is garbage.
 */

type Base = { id: string; seq: number; at: number; connection: { definition: string; id: string } };
/** `connection.<to>` on every state change, straight from the kernel outbox. */
export type LifecycleEvent = Base & { type: `connection.${State}`; data: { from: State | null; to: State; reason?: string } };
/** A provider webhook routed to this connection (#25), shaped by the webhooks extension. */
export type WebhookEvent = Base & { type: "webhook"; data: WebhookData };
/** The POST body. `id` = `<instance>:<seq>`, the same on every retry: dedupe on it. */
export type ConnectionEvent = LifecycleEvent | WebhookEvent;

/** `seq` = last event written, `done` = last delivered or dropped, `kseq` = last kernel event copied in, `retryAt` set while parked. */
type Head = { seq: number; done: number; kseq: number; attempt: number; retryAt: number | null };
type New = { type: ConnectionEvent["type"]; at: number; data: Json };

const HEAD = "events.head";
const TIMER = "events.retry";
const ekey = (seq: number) => `events.e:${seq}`;
const MAX = 1000;
const TIMEOUT_MS = 10_000;
const BACKOFF = { baseMs: 10_000, maxMs: 3_600_000 };

/** Read-decide-cas on the head. `f` returns null to leave it alone. Returns the head after, and the one it replaced. */
async function change(d: Driver, f: (h: Head) => Head | null): Promise<{ now: Head; was: Head }> {
  for (;;) {
    const r = await d.store.get(HEAD);
    const was = (r?.value as unknown as Head | undefined) ?? { seq: 0, done: 0, kseq: 0, attempt: 0, retryAt: null };
    const n = f(was);
    if (!n) return { now: was, was };
    if (await d.store.cas(HEAD, r?.v ?? null, n as unknown as Json)) return { now: n, was };
  }
}

/**
 * Appends are serialized per instance (in memory): keys past `seq` are uncommitted, so two
 * appenders would write the same ones. Only appends take it; delivery just cas'es the head.
 * A crash mid-append leaves keys past `seq`, which the next append overwrites.
 */
const locks = new WeakMap<Driver, Promise<unknown>>();
function locked<T>(d: Driver, fn: () => Promise<T>): Promise<T> {
  const run = (locks.get(d) ?? Promise.resolve()).then(fn);
  locks.set(d, run.catch(() => {}));
  return run;
}

/** Write events past `seq`, then commit them with the head's cas. Past MAX, the oldest are dropped. Call under `locked`. */
async function append(h: Hosted, add: (head: Head) => { items: New[]; kseq: number } | null): Promise<Head> {
  const { d } = h;
  const { now: head } = await change(d, () => null);
  const a = add(head);
  if (!a?.items.length) return head;
  for (const [i, e] of a.items.entries()) {
    const s = head.seq + i + 1;
    // One event must fit one stored value (2 MB on DOs); webhooks.ts drops payloads past MAX_PAYLOAD.
    await d.store.put(ekey(s), { ...e, seq: s, id: `${h.instance}:${s}`, connection: { definition: h.def.id, id: h.id } } as unknown as Json);
  }
  const seq = head.seq + a.items.length;
  const r = await change(d, (cur) => {
    // Delivery only moves done/attempt/retryAt; seq and kseq are ours while locked.
    if (cur.seq !== head.seq) throw new Error("events: concurrent append");
    return { ...cur, seq, kseq: a.kseq, done: Math.max(cur.done, seq - MAX) };
  });
  // Dropped past MAX: free their keys. A crash here leaves garbage below `done`, never read again.
  for (let s = r.was.done + 1; s <= r.now.done; s++) await d.store.delete(ekey(s));
  return r.now;
}

/** Copy new kernel transitions in, then ack them in the kernel. `kseq` commits with the head, so a crash anywhere repeats nothing and skips nothing. */
async function pull(h: Hosted) {
  const ev = await h.bound.conn.events.pending();
  if (!ev.length) return;
  const head = await locked(h.d, () =>
    append(h, (head) => {
      const fresh = ev.filter((e) => e.seq > head.kseq);
      const last = fresh.at(-1);
      if (!last) return null;
      const items = fresh.map((e) => ({ type: `connection.${e.to}` as const, at: e.at, data: { from: e.from, to: e.to, ...(e.reason ? { reason: e.reason } : {}) } }));
      return { items, kseq: last.seq };
    }),
  );
  await h.bound.conn.events.ack(head.kseq);
}

/** Wake the drain: now, or when a parked outbox may retry. */
async function arm(d: Driver) {
  const { now: head } = await change(d, () => null);
  if (head.seq > head.done) await d.timer.set(TIMER, Math.max(d.now(), head.retryAt ?? 0));
}

/**
 * Queue a non-lifecycle event on this connection; the webhook extension (#25) calls this from its
 * connection method or timer. Ordered after every transition so far. No-op without `settings.events`.
 */
export async function emit(h: Hosted, data: Json) {
  if (!h.settings.events) return;
  await pull(h);
  await locked(h.d, () => append(h, (head) => ({ items: [{ type: "webhook", at: h.d.now(), data }], kseq: head.kseq })));
  await arm(h.d);
}

async function post(h: Hosted, cfg: { url: string; secret: string }, e: ConnectionEvent) {
  const body = JSON.stringify(e);
  const ts = Math.floor(h.d.now() / 1000);
  try {
    const res = await (h.settings.fetch ?? fetch)(cfg.url, {
      method: "POST",
      headers: { "content-type": "application/json", "webhook-id": e.id, "webhook-timestamp": String(ts), "webhook-signature": await sign(cfg.secret, e.id, ts, body) },
      body,
      // A followed 302 would turn the POST into a GET, ack it falsely and send signed headers elsewhere.
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.status >= 200 && res.status < 300;
  } catch (err) {
    console.error("event delivery failed", e.id, String(err));
    return false;
  }
}

/** Deliver from the head until empty or a failure; a failure parks the outbox until `retryAt`. */
async function drain(h: Hosted, cfg: { url: string; secret: string }) {
  const { d } = h;
  for (;;) {
    const { now: head } = await change(d, () => null);
    if (head.done >= head.seq) return;
    // Woken early (an arm raced a failure): keep the backoff.
    if (head.retryAt !== null && d.now() < head.retryAt) return d.timer.set(TIMER, head.retryAt);
    const next = head.done + 1;
    const r = await d.store.get(ekey(next));
    const e = r?.value as unknown as ConnectionEvent | undefined;
    // Missing only if an append dropped it past MAX since we read the head; re-read.
    if (!e) continue;
    if (await post(h, cfg, e)) {
      await change(d, (cur) => ({ ...cur, done: Math.max(cur.done, next), attempt: 0, retryAt: null }));
      await d.store.delete(ekey(next));
      continue;
    }
    // ponytail: retries forever at up to 1h apart; no dead-letter or replay API until the dashboard (L4).
    const at = d.now() + backoff(head.attempt, BACKOFF);
    await change(d, (cur) => ({ ...cur, attempt: cur.attempt + 1, retryAt: at }));
    // Not atomic with the cas: if this is lost, the instance's next first after() arms from `retryAt`.
    return d.timer.set(TIMER, at);
  }
}

/**
 * Delivers `ConnectionEvent`s to `settings.events.url`; without `settings.events`, does nothing.
 * `after()` only copies kernel events and arms the timer; the POSTs run in `onTimer`, so a slow
 * endpoint never holds up the method that caused the event. Timers fire one at a time per instance.
 */
export function events(): Extension {
  return {
    connection: (h) => {
      // Kernel event seq last copied, this isolate. -1: copy and arm once after a restart (covers a lost timer).
      let seen = -1;
      return {
        async onTimer(name) {
          if (name !== TIMER) return false;
          if (h.settings.events) {
            await pull(h);
            await drain(h, h.settings.events);
          }
          return true;
        },
        async after() {
          if (!h.settings.events) return;
          // Most calls (token, proxied requests) change no state: one small read, no decrypt.
          const s = await h.bound.conn.events.seq();
          if (s === seen) return;
          await pull(h);
          await arm(h.d);
          seen = s;
        },
      };
    },
  };
}
