import type { State, Transition } from "@openconnect/connections";
import { type Delivery, type Json, type Kernel, type Queue, QueueError, type Summary } from "@openconnect/kernel";
import { Fail, type Hosted } from "./host.ts";
import type { Extension } from "./runtime.ts";
import { sign } from "./signature.ts";
import type { WebhookData } from "./webhooks.ts";

/**
 * Event delivery to the user's server (#24): POST, signed (Standard Webhooks, see signature.ts),
 * at least once, in order per connection. The ordering, retries, history and replay are the
 * kernel's queue (#53); this is what an event is, and how it's signed and sent. Lifecycle
 * transitions reach the queue from the record cell's outbox (`relay`, exactly once); webhooks are
 * pushed after them (`emit`). The POSTs run from the queue's timer, so a slow endpoint never holds
 * up the method that caused the event.
 */

type Base = { id: string; seq: number; at: number; connection: { definition: string; id: string } };
/** `connection.<to>` on every state change, from the lifecycle's record outbox. */
export type LifecycleEvent = Base & { type: `connection.${State}`; data: { from: State | null; to: State; reason?: string } };
/** A provider webhook routed to this connection (#25), shaped by the webhooks extension. */
export type WebhookEvent = Base & { type: "webhook"; data: WebhookData };
/** The POST body. `id` = `<instance>:<seq>`, the same on every retry: dedupe on it. */
export type ConnectionEvent = LifecycleEvent | WebhookEvent;

/** What the queue holds: the body without what the queue and the connection add (`id`, `seq`, `connection`). */
type Msg = { type: ConnectionEvent["type"]; at: number; data: Json };

const MAX = 1000;
/**
 * Done events kept for the dashboard and `events.redeliver`: the newest KEPT, the body only when
 * it's at most BODY_KEPT bytes. So what a connection keeps of done events is bounded by bytes.
 */
export const KEPT = 20;
export const BODY_KEPT = 64 * 1024;
const TIMEOUT_MS = 10_000;
const BACKOFF = { baseMs: 10_000, maxMs: 3_600_000 };

/** One event as `events.status` lists it: no webhook payload, only what names it. */
export type EventSummary = {
  /** Its place in the queue; what `events.redeliver` takes. A redelivered copy has a new slot, and the original's `id` and `seq`. */
  slot: number;
  id: string;
  seq: number;
  type: ConnectionEvent["type"];
  at: number;
  /** Lifecycle: `{ from, to, reason? }`. Webhook: `{ topic, delivery, truncated? }`. */
  data: Json;
  /** Bytes of the stored event. */
  size: number;
  /** A redelivered duplicate (`events.redeliver`) of the event with this `id`. */
  copy: boolean;
  /** When a 2xx took it; null while pending, or dropped. */
  deliveredAt: number | null;
  /** Dropped past the 1000 cap, never delivered. */
  dropped: boolean;
  /** Done and its body was kept (at most BODY_KEPT bytes): `events.redeliver` can send it. */
  redeliverable: boolean;
};

/** `events.status`: the outbox of one connection, for the dashboard (#32). */
export type EventsStatus = {
  /** `settings.events` is set. */
  enabled: boolean;
  /** Events waiting, head first; the head is the one in flight or parked. */
  pending: number;
  attempt: number;
  /** When a parked head is tried again; null while not parked. */
  retryAt: number | null;
  /** Why the head's last attempt failed: `HTTP 500`, `timeout`, `network error: ...`. */
  error: string | null;
  /** The first pending events, head first. */
  queued: EventSummary[];
  /** The KEPT newest done events (delivered, or dropped past the 1000 cap), newest first. */
  recent: EventSummary[];
};

/** Each connection's queue, so another extension (webhooks) can add to it. */
const queues = new WeakMap<Kernel, { q: Queue<Msg>; relay(): Promise<void> }>();

/**
 * Queue a non-lifecycle event on this connection; the webhook extension (#25) calls this. Ordered
 * after every transition so far. No-op without `settings.events` or the events extension.
 */
export async function emit(h: Hosted, data: Json) {
  const e = queues.get(h.k);
  if (!h.settings.events || !e) return;
  await e.relay();
  await e.q.push([{ type: "webhook", at: h.k.now(), data }]);
}

/** What status lists for a stored event: webhook payloads left out. */
function summarize(m: Msg): Json {
  const w = m.data as unknown as WebhookData;
  const data = m.type === "webhook" ? { topic: w.topic, delivery: w.delivery, ...(w.truncated ? { truncated: w.truncated } : {}) } : m.data;
  return { type: m.type, at: m.at, data } as unknown as Json;
}

const summary = ({ summary: s, ...rest }: Summary): EventSummary => ({ ...rest, ...(s as unknown as Pick<EventSummary, "type" | "at" | "data">) });

const off = () => new Fail("not_configured", 503, "settings.events is not set");

/** The queue's errors as HTTP faults. */
function queueFault(e: unknown): never {
  if (!(e instanceof QueueError)) throw e;
  const status = { pending: 409, not_found: 404, payload_not_retained: 410 }[e.code];
  throw new Fail(e.code, status, e.message);
}

/**
 * Delivers `ConnectionEvent`s to `settings.events.url`; without `settings.events`, does nothing.
 */
export function events(): Extension {
  return {
    connection: (h) => {
      const connection = { definition: h.def.id, id: h.id };

      /** null on a 2xx, else why it failed (for the dashboard: no URL, header or body in it). */
      async function post(m: Delivery<Msg>): Promise<string | null> {
        const cfg = h.settings.events;
        // Turned off with events still queued: they wait, parked, until it's on again.
        if (!cfg) return "settings.events is not set";
        const e = { type: m.msg.type, at: m.msg.at, data: m.msg.data, seq: m.seq, id: m.id, connection } as ConnectionEvent;
        const body = JSON.stringify(e);
        const ts = Math.floor(h.k.now() / 1000);
        try {
          const res = await (h.settings.fetch ?? fetch)(cfg.url, {
            method: "POST",
            headers: { "content-type": "application/json", "webhook-id": e.id, "webhook-timestamp": String(ts), "webhook-signature": await sign(cfg.secret, e.id, ts, body) },
            body,
            // A followed 302 would turn the POST into a GET, ack it falsely and send signed headers elsewhere.
            redirect: "manual",
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
          return res.status >= 200 && res.status < 300 ? null : `HTTP ${res.status}`;
        } catch (err) {
          console.error("event delivery failed", e.id, String(err));
          return err instanceof Error && err.name === "TimeoutError" ? "timeout" : `network error: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      const q = h.k.queue<Msg>("events", {
        deliver: post,
        retry: BACKOFF,
        max: MAX,
        keep: KEPT,
        keepBodyBytes: BODY_KEPT,
        // #24's ids: the same on every retry and across redeliveries.
        id: (seq) => `${h.instance}:${seq}`,
        summary: summarize,
      });
      const record = h.bound.conn.record;
      /** Lifecycle transitions from the record's outbox into the queue, as `connection.<to>` events. */
      const relay = async () => {
        if (!h.settings.events) return;
        await q.relay({
          name: record.name,
          outbox: {
            pending: async () =>
              (await record.outbox.pending()).map((i) => ({
                seq: i.seq,
                msg: { type: `connection.${i.msg.to}` as const, at: i.msg.at, data: transition(i.msg) },
              })),
            ack: record.outbox.ack,
          },
        });
      };
      queues.set(h.k, { q, relay });
      // A fresh isolate wakes the queue once: covers a drain timer lost in a crash.
      let woken = false;

      return {
        methods: {
          "events.status": async () => {
            const s = await q.status();
            return { enabled: !!h.settings.events, ...s, queued: s.queued.map(summary), recent: s.recent.map(summary) } satisfies EventsStatus as unknown as Json;
          },
          /** Skip a parked head's backoff: the drain runs now, from the timer (one delivery in flight, in order). */
          "events.flush": async () => {
            if (!h.settings.events) throw off();
            await q.flush();
            const s = await q.status();
            return { enabled: true, ...s, queued: s.queued.map(summary), recent: s.recent.map(summary) } satisfies EventsStatus as unknown as Json;
          },
          /**
           * Send a done event again (`{ slot }`, one of `recent`): a copy goes to the back of the queue,
           * the same body, `webhook-id` and `seq`, as an at-least-once duplicate would; it takes no new
           * seq, so later events keep counting from the last real one. It arrives after newer events
           * (out of order, like any duplicate). A receiver deduping on `webhook-id` skips it; clear the
           * id there to have it processed again.
           */
          "events.redeliver": async (a) => {
            if (!h.settings.events) throw off();
            const slot = (a as { slot?: Json } | null)?.slot;
            if (typeof slot !== "number" || !Number.isInteger(slot)) throw new Fail("bad_request", 400, "slot must be an integer");
            return (await q.redeliver(slot).catch(queueFault)) as unknown as Json;
          },
        },
        async after() {
          if (!h.settings.events) return;
          // Most calls (token, proxied requests) change no state: one small read of the record, no decrypt.
          await relay();
          if (!woken) {
            await q.wake();
            woken = true;
          }
        },
      };
    },
  };
}

const transition = (t: Transition): Json => ({ from: t.from, to: t.to, ...(t.reason ? { reason: t.reason } : {}) });
