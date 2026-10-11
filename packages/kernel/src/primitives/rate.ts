import type { Driver, Json } from "../driver.ts";

/**
 * Rate limits with GCRA. State per key is one number, the theoretical arrival time (TAT).
 * A fresh key admits `count` at once, then one every periodMs/count.
 *
 * A scope (connection, app, workspace, anything) is an instance key plus a limit key. Scopes on
 * other instances are reached through `d.call`, so the Program must route RATE to `handleRate`.
 */

export type Limit = { count: number; periodMs: number };
export type Scope = { instance: string; key: string; limit: Limit };
export type Verdict = { ok: true } | { ok: false; retryAfterMs: number };
/** What a provider told us: `X-RateLimit-Remaining` / `-Reset`, or `Retry-After`. */
export type Observed = { remaining?: number; resetAt?: number; retryAfterMs?: number };

export const RATE = "kernel.rate";

const sk = (key: string) => `rate:${key}`;

/** Read-modify-cas on one key until it lands. `f` returns the new TAT, or null to leave it. */
async function update(d: Driver, key: string, f: (tat: number, now: number) => number | null) {
  for (;;) {
    const r = await d.store.get(sk(key));
    const now = d.now();
    const tat = f(Math.max((r?.value as number | undefined) ?? now, now), now);
    if (tat === null) return;
    // Once TAT is in the past the key is as good as fresh, so let it expire.
    if (await d.store.cas(sk(key), r?.v ?? null, tat, { ttlMs: Math.max(1, tat - now) })) return;
  }
}

export async function acquireLocal(d: Driver, key: string, limit: Limit, n = 1): Promise<Verdict> {
  const t = limit.periodMs / limit.count;
  let verdict: Verdict = { ok: true };
  await update(d, key, (tat, now) => {
    const next = tat + n * t;
    const allowAt = next - limit.periodMs;
    verdict = allowAt > now ? { ok: false, retryAfterMs: Math.ceil(allowAt - now) } : { ok: true };
    return verdict.ok ? next : null;
  });
  return verdict;
}

export const refundLocal = (d: Driver, key: string, limit: Limit, n = 1) =>
  update(d, key, (tat, now) => Math.max(now, tat - (n * limit.periodMs) / limit.count));

/** Tighten (never loosen) our count from what the provider reported. */
export const observeLocal = (d: Driver, key: string, limit: Limit, o: Observed) =>
  update(d, key, (tat, now) => {
    const t = limit.periodMs / limit.count;
    let floor = tat;
    if (o.retryAfterMs !== undefined) floor = Math.max(floor, now + o.retryAfterMs + limit.periodMs - t);
    if (o.remaining === 0 && o.resetAt !== undefined) floor = Math.max(floor, o.resetAt + limit.periodMs - t);
    // ponytail: remaining > 0 only caps the burst to `remaining`; it doesn't also hold the refill until resetAt.
    else if (o.remaining !== undefined) floor = Math.max(floor, now + limit.periodMs - o.remaining * t);
    return floor > tat ? floor : null;
  });

type Op = { op: "acquire" | "refund" | "observe"; key: string; limit: Limit; n?: number; observed?: Observed };

/** Route `onCall(RATE, args)` here. */
export async function handleRate(d: Driver, args: Json): Promise<Json> {
  const a = args as unknown as Op;
  if (a.op === "acquire") return acquireLocal(d, a.key, a.limit, a.n);
  if (a.op === "refund") await refundLocal(d, a.key, a.limit, a.n);
  else if (a.op === "observe") await observeLocal(d, a.key, a.limit, a.observed ?? {});
  else throw new Error(`rate: unknown op ${String(a.op)}`);
  return null;
}

const run = (d: Driver, self: string, s: Scope, op: Op["op"], extra: { n?: number; observed?: Observed }) =>
  s.instance === self
    ? handleRate(d, { op, key: s.key, limit: s.limit, ...extra } as unknown as Json)
    : d.call(s.instance, RATE, { op, key: s.key, limit: s.limit, ...extra } as unknown as Json);

/**
 * Take `n` from every scope, in order. All or nothing: on a deny, earlier grants are refunded.
 * Rejects rather than queues; the caller waits `retryAfterMs` or gives up.
 * ponytail: no cross-tenant fairness on a shared scope, and one instance per scope (~1k rps);
 * shard the scope key if a single app limit runs hotter than that.
 */
export async function acquire(d: Driver, self: string, scopes: Scope[], n = 1): Promise<Verdict> {
  const done: Scope[] = [];
  for (const s of scopes) {
    const v = (await run(d, self, s, "acquire", { n })) as Verdict;
    if (!v.ok) {
      await Promise.all(done.map((g) => run(d, self, g, "refund", { n })));
      return v;
    }
    done.push(s);
  }
  return { ok: true };
}

export const refund = (d: Driver, self: string, scopes: Scope[], n = 1) =>
  Promise.all(scopes.map((s) => run(d, self, s, "refund", { n }))).then(() => {});

export const observe = (d: Driver, self: string, scope: Scope, observed: Observed) =>
  run(d, self, scope, "observe", { observed }).then(() => {});
