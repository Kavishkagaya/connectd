import type { Driver, Json } from "./driver.ts";
import { loop } from "./cell.ts";

/**
 * Rate limits with GCRA: per limiter, one number, the time the next permit is free (TAT). A fresh
 * limiter allows a burst of `count`, then one every periodMs/count. Same algorithm as #9, on `loop`.
 */

export type Limit = { count: number; periodMs: number };
export type Verdict = { ok: true } | { ok: false; retryAfterMs: number };
/** What a provider said: `X-RateLimit-Remaining` / `-Reset`, or `Retry-After`. */
export type Observed = { remaining?: number; resetAt?: number; retryAfterMs?: number };

/** The connection method other instances call to use a limiter that lives here. Answered by `serve`. */
export const RATE = "kernel.rate";

export type Limiter = {
  readonly instance: string;
  readonly name: string;
  readonly limit: Limit;
  /** Tighten (never loosen) from what the provider reported. */
  observe(o: Observed): Promise<void>;
};

type Op = { op: "acquire" | "refund" | "observe"; name: string; limit: Limit; n?: number; observed?: Observed };

const rateKey = (name: string) => `r:${name}`;

/** Read-modify-cas on one limiter's TAT. `f` returns the new TAT, or null to leave it. Expires once it's in the past. */
const update = <T>(d: Driver, name: string, f: (tat: number, now: number) => { tat: number | null; result: T }) =>
  loop(d, rateKey(name), (cur) => {
    const now = d.now();
    const { tat, result } = f(Math.max((cur?.value as number | undefined) ?? now, now), now);
    return tat === null ? { result } : { result, write: tat, ttlMs: Math.max(1, tat - now) };
  });

/** Runs one op on a limiter stored in this instance (a local call, or `kernel.rate` from another). */
export async function rate(d: Driver, args: Json): Promise<Json> {
  const { op, name, limit, n = 1, observed = {} } = args as unknown as Op;
  const t = limit.periodMs / limit.count;
  if (op === "acquire")
    return update<Verdict>(d, name, (tat, now) => {
      const next = tat + n * t;
      const allowAt = next - limit.periodMs;
      return allowAt > now ? { tat: null, result: { ok: false, retryAfterMs: Math.ceil(allowAt - now) } } : { tat: next, result: { ok: true } };
    }) as Promise<Json>;
  if (op === "refund") await update(d, name, (tat, now) => ({ tat: Math.max(now, tat - n * t), result: null }));
  else if (op === "observe")
    await update(d, name, (tat, now) => {
      let floor = tat;
      if (observed.retryAfterMs !== undefined) floor = Math.max(floor, now + observed.retryAfterMs + limit.periodMs - t);
      if (observed.remaining === 0 && observed.resetAt !== undefined) floor = Math.max(floor, observed.resetAt + limit.periodMs - t);
      // ponytail: remaining > 0 only caps the burst to `remaining`; it doesn't also hold the refill until resetAt.
      else if (observed.remaining !== undefined) floor = Math.max(floor, now + limit.periodMs - observed.remaining * t);
      return { tat: floor > tat ? floor : null, result: null };
    });
  else throw new Error(`rate: unknown op ${String(op)}`);
  return null;
}

/** A limiter handle: here, or in another instance (an app-wide scope) reached with `driver.call`. */
export function limiter(d: Driver, self: string, instance: string, name: string, limit: Limit) {
  const run = (op: Op["op"], extra: { n?: number; observed?: Observed } = {}) => {
    const args = { op, name, limit, ...extra } as unknown as Json;
    return instance === self ? rate(d, args) : d.call(instance, RATE, args);
  };
  const l: Limiter = { instance, name, limit, observe: async (observed) => void (await run("observe", { observed })) };
  runners.set(l, run);
  return l;
}

/** How each handle runs an op, kept off the public handle. */
const runners = new WeakMap<Limiter, (op: Op["op"], extra?: { n?: number }) => Promise<Json>>();
const runner = (l: Limiter) => {
  const r = runners.get(l);
  if (!r) throw new Error(`limiter ${l.name}: not a kernel limiter`);
  return r;
};

/**
 * Take `n` from every limiter, in order. All or nothing: on a deny, earlier grants are refunded.
 * Says how long to wait; never waits itself.
 * ponytail: one instance per shared limiter (~1k rps); split the name if an app limit runs hotter.
 */
export async function acquire(ls: Limiter[], n = 1): Promise<Verdict> {
  const done: Limiter[] = [];
  for (const l of ls) {
    const v = (await runner(l)("acquire", { n })) as unknown as Verdict;
    if (!v.ok) {
      await Promise.all(done.map((g) => runner(g)("refund", { n })));
      return v;
    }
    done.push(l);
  }
  return { ok: true };
}

/** Give permits back (the request never left). */
export const refund = async (ls: Limiter[], n = 1) => void (await Promise.all(ls.map((l) => runner(l)("refund", { n }))));
