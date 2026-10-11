import type { Driver, Json } from "../driver.ts";

// Timer multiplexing lives in the drivers (#13, #14): any number of named timers per instance.
// This adds retries. Recurring work re-arms its own timer from onTimer; no cron here.

export type Backoff = { baseMs?: number; maxMs?: number; maxAttempts?: number };

/** Exponential with equal jitter: in [cap/2, cap], cap = min(maxMs, baseMs * 2^attempt). Never 0, so no retry storms. */
export function backoff(attempt: number, { baseMs = 1000, maxMs = 3_600_000 }: Backoff = {}, random = Math.random) {
  const cap = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.round(cap / 2 + (random() * cap) / 2);
}

export type RetryPayload = { attempt: number; data: Json };

/**
 * Re-arm timer `name` after failure number `attempt` (0-based). The count rides in the payload
 * ({ attempt, data }), so it survives restarts. False once maxAttempts is used up: the caller
 * decides what giving up means.
 */
export async function retry(d: Driver, name: string, attempt: number, data: Json, opts: Backoff = {}) {
  if (attempt + 1 >= (opts.maxAttempts ?? 10)) return false;
  await d.timer.set(name, d.now() + backoff(attempt, opts), { attempt: attempt + 1, data });
  return true;
}
