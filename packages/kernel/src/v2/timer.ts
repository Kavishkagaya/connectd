import type { Driver, Json } from "../driver.ts";
import { type Backoff, backoff } from "../primitives/schedule.ts";

export type TimerOptions<P extends Json> = {
  /** What to do when it rings. Return = done; throw = try again later (with `retry`). */
  handle(payload: P, info: { attempt: number }): Promise<void>;
  /** Retry a throwing `handle` with growing, random waits. `maxAttempts` counts the first try. */
  retry?: Backoff & { maxAttempts: number };
  /** After the last attempt failed. */
  giveUp?(payload: P, error: unknown): Promise<void>;
};

export type Timer<P extends Json> = {
  /** Ring at `at` (one alarm per name: setting again replaces it). */
  set(at: number, ...payload: P extends null ? [] | [null] : [P]): Promise<void>;
  cancel(): Promise<void>;
};

/** What the alarm stores. The attempt rides along, so a restart doesn't reset it. */
type Stored = { attempt: number; data: Json };

/**
 * A named alarm and its handler, declared together: an alarm nobody handles can't exist. An alarm
 * is a nudge: timer and cell writes aren't atomic, so whatever it does must also happen on demand,
 * and `handle` re-checks before acting (running twice is harmless). Recurring work sets itself again.
 */
export function timer<P extends Json>(d: Driver, instance: string, name: string, o: TimerOptions<P>) {
  const t: Timer<P> = {
    set: (at, ...payload) => d.timer.set(name, at, { attempt: 0, data: payload[0] ?? null } satisfies Stored),
    cancel: () => d.timer.cancel(name),
  };
  /** Routed here by `serve` when the driver fires `name`. */
  async function fire(raw: Json) {
    const { attempt = 0, data = null } = (raw ?? {}) as Partial<Stored>;
    try {
      await o.handle(data as P, { attempt });
    } catch (e) {
      console.error("timer failed", instance, name, attempt, e);
      if (o.retry && attempt + 1 < o.retry.maxAttempts) {
        await d.timer.set(name, d.now() + backoff(attempt, o.retry), { attempt: attempt + 1, data } satisfies Stored);
      } else if (o.giveUp) {
        await o.giveUp(data as P, e).catch((err) => console.error("timer giveUp failed", instance, name, err));
      }
    }
  }
  return { timer: t, fire };
}
