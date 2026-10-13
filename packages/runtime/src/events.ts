import { backoff, type Json, type State } from "@openconnect/kernel";
import type { Hosted } from "./host.ts";
import type { Extension } from "./runtime.ts";
import { sign } from "./signature.ts";

/**
 * Event delivery to the user's server: POST, signed (Standard Webhooks, see signature.ts),
 * at least once, in order per connection. Each connection drains its own outbox, one event at a
 * time, from its durable `events.retry` timer; a failure parks the outbox until the next attempt.
 */

type Base = { id: string; seq: number; at: number; connection: { definition: string; id: string } };
/** `connection.<to>` on every state change, straight from the kernel outbox. */
export type LifecycleEvent = Base & { type: `connection.${State}`; data: { from: State | null; to: State; reason?: string } };
/** A provider webhook routed to this connection (#25). `data` is whatever the webhook extension emits. */
export type WebhookEvent = Base & { type: "webhook"; data: Json };
/** The POST body. `id` = `<instance>:<seq>`, the same on every retry: dedupe on it. */
export type ConnectionEvent = LifecycleEvent | WebhookEvent;

/** Delivery's own outbox. `kseq` = last kernel event moved in; `retryAt` set while parked after a failure. */
type Box = { seq: number; kseq: number; attempt: number; retryAt: number | null; items: ConnectionEvent[] };

const KEY = "events.outbox";
const TIMER = "events.retry";
const MAX = 1000;
const TIMEOUT_MS = 10_000;
const BACKOFF = { baseMs: 10_000, maxMs: 3_600_000 };

async function change(h: Hosted, f: (b: Box) => Box | null): Promise<Box> {
  for (;;) {
    const r = await h.d.store.get(KEY);
    const b = (r?.value as unknown as Box | undefined) ?? { seq: 0, kseq: 0, attempt: 0, retryAt: null, items: [] };
    const n = f(b);
    if (!n) return b;
    if (await h.d.store.cas(KEY, r?.v ?? null, n as unknown as Json)) return n;
  }
}

function push(h: Hosted, b: Box, add: Pick<ConnectionEvent, "type" | "at" | "data">[], kseq = b.kseq): Box {
  let seq = b.seq;
  const items = add.map((e) => ({ ...e, seq: ++seq, id: `${h.instance}:${seq}`, connection: { definition: h.def.id, id: h.id } }) as ConnectionEvent);
  // ponytail: one key, oldest dropped past MAX while the endpoint is down; spill to per-event keys (or a Queue) if that bites.
  return { ...b, seq, kseq, items: [...b.items, ...items].slice(-MAX) };
}

/** Move new kernel transitions into the delivery outbox, then ack them there. `kseq` makes a repeat after a crash a no-op. */
async function pull(h: Hosted) {
  const ev = await h.bound.conn.events.pending();
  if (!ev.length) return;
  const b = await change(h, (b) => {
    const fresh = ev.filter((e) => e.seq > b.kseq);
    if (!fresh.length) return null;
    const add = fresh.map((e) => ({ type: `connection.${e.to}` as const, at: e.at, data: { from: e.from, to: e.to, ...(e.reason ? { reason: e.reason } : {}) } }));
    return push(h, b, add, fresh.at(-1)!.seq);
  });
  await h.bound.conn.events.ack(b.kseq);
}

/**
 * Queue a non-lifecycle event on this connection; the webhook extension (#25) calls this from its
 * connection method or timer, and `after()` delivers it. Ordered after every transition so far.
 * No-op without `settings.events`.
 */
export async function emit(h: Hosted, data: Json) {
  if (!h.settings.events) return;
  await pull(h);
  await change(h, (b) => push(h, b, [{ type: "webhook", at: h.d.now(), data }]));
}

async function post(h: Hosted, cfg: { url: string; secret: string }, e: ConnectionEvent) {
  const body = JSON.stringify(e);
  const ts = Math.floor(h.d.now() / 1000);
  try {
    const res = await (h.settings.fetch ?? fetch)(cfg.url, {
      method: "POST",
      headers: { "content-type": "application/json", "webhook-id": e.id, "webhook-timestamp": String(ts), "webhook-signature": await sign(cfg.secret, e.id, ts, body) },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.ok;
  } catch (err) {
    console.error("event delivery failed", e.id, String(err));
    return false;
  }
}

/** Wake the drain: now, or when a parked outbox may retry. */
async function arm(h: Hosted) {
  const b = await change(h, () => null);
  if (b.items.length) await h.d.timer.set(TIMER, Math.max(h.d.now(), b.retryAt ?? 0));
}

/** Deliver from the head until empty or a failure; a failure parks the outbox until `retryAt`. */
async function drain(h: Hosted, cfg: { url: string; secret: string }) {
  for (;;) {
    const b = await change(h, () => null);
    const e = b.items[0];
    if (!e) return;
    // Woken early (an arm raced a failure): keep the backoff.
    if (b.retryAt !== null && h.d.now() < b.retryAt) return h.d.timer.set(TIMER, b.retryAt);
    if (await post(h, cfg, e)) {
      await change(h, (b) => ({ ...b, attempt: 0, retryAt: null, items: b.items.filter((x) => x.seq > e.seq) }));
      continue;
    }
    // ponytail: retries forever at up to 1h apart; no dead-letter or replay API until the dashboard (L4).
    const at = h.d.now() + backoff(b.attempt, BACKOFF);
    await change(h, (b) => ({ ...b, attempt: b.attempt + 1, retryAt: at }));
    // Not atomic with the cas: if this is lost, the next after() arms from `retryAt`.
    return h.d.timer.set(TIMER, at);
  }
}

/**
 * Delivers `ConnectionEvent`s to `settings.events.url`; without `settings.events`, does nothing.
 * `after()` only moves events and arms a timer; the POSTs run in `onTimer`, so a slow endpoint never
 * holds up the method that caused the event. Timers fire one at a time per instance, so drains don't overlap.
 */
export const events: Extension = {
  connection: (h) => ({
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
      await pull(h);
      await arm(h);
    },
  }),
};
