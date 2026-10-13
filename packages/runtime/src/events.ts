import { backoff, type Driver, type Json, type State } from "@openconnect/kernel";
import { Fail, type Hosted } from "./host.ts";
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

/**
 * The outbox is a sequence of slots; each holds an event to POST. `slot` = last slot written,
 * `done` = last slot delivered or dropped, `seq` = last event seq given out (events are numbered on
 * their own: a redelivered copy takes a slot but no seq, so seqs stay gapless), `kseq` = last kernel
 * event copied in, `retryAt` set while parked, `error` = why the head's last attempt failed (cleared by a 2xx).
 */
type Head = { slot: number; seq: number; done: number; kseq: number; attempt: number; retryAt: number | null; error?: string | null };
/** A new event (numbered at append), or a redelivered copy of a stored one: same `id`, `seq` and body. */
type New = { type: ConnectionEvent["type"]; at: number; data: Json } | { copy: ConnectionEvent };

const HEAD = "events.head";
const TIMER = "events.retry";
/** The event as POSTed: written at append; once done, kept only if under BODY_KEPT. */
const ekey = (slot: number) => `events.e:${slot}`;
/** Its summary (no payload), what `events.status` reads. */
const skey = (slot: number) => `events.s:${slot}`;
const MAX = 1000;
/**
 * Done events (delivered, or dropped past MAX) kept for the dashboard and `events.redeliver`: the
 * newest KEPT, as summaries, with the body only when it's at most BODY_KEPT bytes. So what a
 * connection keeps of done events is bounded by bytes: KEPT × (BODY_KEPT + a summary) ≈ 1.3 MB.
 */
export const KEPT = 20;
export const BODY_KEPT = 64 * 1024;
/** Queued events `events.status` lists, head first. */
const QUEUED = 20;
const TIMEOUT_MS = 10_000;
const BACKOFF = { baseMs: 10_000, maxMs: 3_600_000 };

/** Read-decide-cas on the head. `f` returns null to leave it alone. Returns the head after, and the one it replaced. */
async function change(d: Driver, f: (h: Head) => Head | null): Promise<{ now: Head; was: Head }> {
  for (;;) {
    const r = await d.store.get(HEAD);
    const v = r?.value as unknown as (Omit<Head, "slot"> & { slot?: number }) | undefined;
    // A head from before redelivery (#32) had slot = seq.
    const was: Head = v ? { ...v, slot: v.slot ?? v.seq } : { slot: 0, seq: 0, done: 0, kseq: 0, attempt: 0, retryAt: null };
    const n = f(was);
    if (!n) return { now: was, was };
    if (await d.store.cas(HEAD, r?.v ?? null, n as unknown as Json)) return { now: n, was };
  }
}

/**
 * Appends are serialized per instance (in memory): keys past `slot` are uncommitted, so two
 * appenders would write the same ones. Only appends take it; delivery just cas'es the head.
 * A crash mid-append leaves keys past `slot`, which the next append overwrites.
 */
const locks = new WeakMap<Driver, Promise<unknown>>();
function locked<T>(d: Driver, fn: () => Promise<T>): Promise<T> {
  const run = (locks.get(d) ?? Promise.resolve()).then(fn);
  locks.set(d, run.catch(() => {}));
  return run;
}

type Stored = Omit<EventSummary, "redeliverable">;
const utf8 = new TextEncoder();

/** Write events past `slot`, then commit them with the head's cas. Past MAX, the oldest are dropped. Call under `locked`. */
async function append(h: Hosted, add: (head: Head) => { items: New[]; kseq: number } | null): Promise<Head> {
  const { d } = h;
  const { now: head } = await change(d, () => null);
  const a = add(head);
  if (!a?.items.length) return head;
  let seq = head.seq;
  for (const [i, n] of a.items.entries()) {
    const slot = head.slot + i + 1;
    const e = "copy" in n ? n.copy : ({ ...n, seq: ++seq, id: `${h.instance}:${seq}`, connection: { definition: h.def.id, id: h.id } } as ConnectionEvent);
    // One event must fit one stored value (2 MB on DOs); webhooks.ts drops payloads past MAX_PAYLOAD.
    await d.store.put(ekey(slot), e as unknown as Json);
    const size = utf8.encode(JSON.stringify(e)).length;
    await d.store.put(skey(slot), { ...summary(slot, e), size, copy: "copy" in n, deliveredAt: null, dropped: false } satisfies Stored as unknown as Json);
  }
  const slot = head.slot + a.items.length;
  const r = await change(d, (cur) => {
    // Delivery only moves done/attempt/retryAt; slot, seq and kseq are ours while locked.
    if (cur.slot !== head.slot) throw new Error("events: concurrent append");
    return { ...cur, slot, seq, kseq: a.kseq, done: Math.max(cur.done, slot - MAX) };
  });
  // Dropped past MAX: done now, never delivered.
  await finish(d, r.was.done, r.now.done, null);
  return r.now;
}

/**
 * `done` moved from `from` to `to` (delivered at `at`, or dropped: null). Slots that fell out of the
 * KEPT newest done are freed; the newly done ones keep their summary, and their body only if small.
 * Not atomic with the head's cas: a crash here leaves a summary not marked delivered and a body
 * kept until the slot falls out of the window, or garbage below `done - KEPT`, never read again.
 */
async function finish(d: Driver, from: number, to: number, at: number | null) {
  for (let s = Math.max(0, from - KEPT) + 1; s <= to - KEPT; s++) {
    await d.store.delete(ekey(s));
    await d.store.delete(skey(s));
  }
  for (let s = Math.max(from, to - KEPT) + 1; s <= to; s++) {
    const k = (await d.store.get(skey(s)))?.value as unknown as Stored | undefined;
    if (k) await d.store.put(skey(s), { ...k, deliveredAt: at, dropped: at === null } as unknown as Json);
    if (!k || k.size > BODY_KEPT) await d.store.delete(ekey(s));
  }
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
  if (head.slot > head.done) await d.timer.set(TIMER, Math.max(d.now(), head.retryAt ?? 0));
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

/** null on a 2xx, else why it failed (for the dashboard: no URL, header or body in it). */
async function post(h: Hosted, cfg: { url: string; secret: string }, e: ConnectionEvent): Promise<string | null> {
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
    return res.status >= 200 && res.status < 300 ? null : `HTTP ${res.status}`;
  } catch (err) {
    console.error("event delivery failed", e.id, String(err));
    return err instanceof Error && err.name === "TimeoutError" ? "timeout" : `network error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Deliver from the head until empty or a failure; a failure parks the outbox until `retryAt`. */
async function drain(h: Hosted, cfg: { url: string; secret: string }) {
  const { d } = h;
  for (;;) {
    const { now: head } = await change(d, () => null);
    if (head.done >= head.slot) return;
    // Woken early (an arm raced a failure): keep the backoff.
    if (head.retryAt !== null && d.now() < head.retryAt) return d.timer.set(TIMER, head.retryAt);
    const next = head.done + 1;
    const r = await d.store.get(ekey(next));
    const e = r?.value as unknown as ConnectionEvent | undefined;
    // Missing only if an append dropped it past MAX since we read the head; re-read.
    if (!e) continue;
    const error = await post(h, cfg, e);
    if (error === null) {
      const r = await change(d, (cur) => ({ ...cur, done: Math.max(cur.done, next), attempt: 0, retryAt: null, error: null }));
      await finish(d, r.was.done, r.now.done, d.now());
      continue;
    }
    // ponytail: retries forever at up to 1h apart; no dead-letter. The dashboard shows the parked head and can flush it (#32).
    const at = d.now() + backoff(head.attempt, BACKOFF);
    await change(d, (cur) => ({ ...cur, attempt: cur.attempt + 1, retryAt: at, error }));
    // Not atomic with the cas: if this is lost, the instance's next first after() arms from `retryAt`.
    return d.timer.set(TIMER, at);
  }
}

/** One event as `events.status` lists it: no webhook payload, only what names it. */
export type EventSummary = {
  /** Its place in this outbox; what `events.redeliver` takes. A redelivered copy has a new slot, and the original's `id` and `seq`. */
  slot: number;
  id: string;
  seq: number;
  type: ConnectionEvent["type"];
  at: number;
  /** Lifecycle: `{ from, to, reason? }`. Webhook: `{ topic, delivery, truncated? }`. */
  data: Json;
  /** Bytes of the POST body. */
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
  /** The first QUEUED pending events, head first. */
  queued: EventSummary[];
  /** The KEPT newest done events (delivered, or dropped past the 1000 cap), newest first. */
  recent: EventSummary[];
};

function summary(slot: number, e: ConnectionEvent) {
  const d = e.type === "webhook" ? { topic: e.data.topic, delivery: e.data.delivery, ...(e.data.truncated ? { truncated: e.data.truncated } : {}) } : e.data;
  return { slot, id: e.id, seq: e.seq, type: e.type, at: e.at, data: d as Json };
}

/** Summaries only: no event body is read (pending ones written before #32 have none, and are read once to make one). */
async function status(h: Hosted): Promise<EventsStatus> {
  const { d } = h;
  const { now: head } = await change(d, () => null);
  const read = async (from: number, to: number) => {
    const out: EventSummary[] = [];
    for (let s = from; s <= to; s++) {
      let k = (await d.store.get(skey(s)))?.value as unknown as Stored | undefined;
      if (!k) {
        const e = (await d.store.get(ekey(s)))?.value as unknown as ConnectionEvent | undefined;
        if (e) k = { ...summary(s, e), size: utf8.encode(JSON.stringify(e)).length, copy: false, deliveredAt: null, dropped: false };
      }
      if (k) out.push({ ...k, redeliverable: s <= head.done && k.size <= BODY_KEPT });
    }
    return out;
  };
  return {
    enabled: !!h.settings.events,
    pending: head.slot - head.done,
    attempt: head.attempt,
    retryAt: head.retryAt,
    error: head.error ?? null,
    queued: await read(head.done + 1, Math.min(head.slot, head.done + QUEUED)),
    recent: (await read(Math.max(1, head.done - KEPT + 1), head.done)).reverse(),
  };
}

const off = () => new Fail("not_configured", 503, "settings.events is not set");

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
        methods: {
          "events.status": async () => (await status(h)) as unknown as Json,
          /** Skip a parked head's backoff: the drain runs now, from the timer (one delivery in flight, in order). */
          "events.flush": async () => {
            if (!h.settings.events) throw off();
            await change(h.d, (cur) => (cur.retryAt === null ? null : { ...cur, retryAt: null }));
            await arm(h.d);
            return (await status(h)) as unknown as Json;
          },
          /**
           * Send a done event again (`{ slot }`, one of `recent`): a copy goes to the back of the outbox,
           * the same body, `webhook-id` and `seq`, as an at-least-once duplicate would; it takes no new
           * seq, so later events keep counting from the last real one. It arrives after newer events
           * (out of order, like any duplicate). A receiver deduping on `webhook-id` skips it; clear the
           * id there to have it processed again.
           */
          "events.redeliver": async (a) => {
            if (!h.settings.events) throw off();
            const slot = (a as { slot?: Json } | null)?.slot;
            if (typeof slot !== "number" || !Number.isInteger(slot)) throw new Fail("bad_request", 400, "slot must be an integer");
            const head = await locked(h.d, async () => {
              const { now: cur } = await change(h.d, () => null);
              if (slot > cur.done) throw new Fail("pending", 409, "that event hasn't been delivered yet");
              const kept = slot > cur.done - KEPT && slot >= 1 && (await h.d.store.get(skey(slot))) !== null;
              const e = kept ? ((await h.d.store.get(ekey(slot)))?.value as unknown as ConnectionEvent | undefined) : undefined;
              if (!kept) throw new Fail("not_found", 404, `only the ${KEPT} newest done events are kept`);
              if (!e) throw new Fail("payload_not_retained", 410, `the body wasn't kept: done events keep theirs only up to ${BODY_KEPT} bytes`);
              return append(h, (cur) => ({ items: [{ copy: e }], kseq: cur.kseq }));
            });
            await arm(h.d);
            return { slot: head.slot };
          },
        },
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
