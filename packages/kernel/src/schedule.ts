// The wait between retries (timers, the queue). Pure: retrying itself is the timer's job (#53).

export type Backoff = { baseMs?: number; maxMs?: number; maxAttempts?: number };

/** Exponential with equal jitter: in [cap/2, cap], cap = min(maxMs, baseMs * 2^attempt). Never 0, so no retry storms. */
export function backoff(attempt: number, { baseMs = 1000, maxMs = 3_600_000 }: Backoff = {}, random = Math.random) {
  const cap = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.round(cap / 2 + (random() * cap) / 2);
}
