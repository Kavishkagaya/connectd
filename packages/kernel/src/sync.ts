/**
 * In-memory coordination inside one instance. Safe because each instance has exactly one copy
 * (a Durable Object, or one memory-driver entry). Lost on restart, and so is everyone waiting.
 */

const clear = () => {};

export type Flight<T> = { run(fn: () => Promise<T>): Promise<T> };

/**
 * Single-flight: callers that arrive while a run is going share it, its result and its error.
 * Once it settles, the next caller starts a new run. An optimization only: correctness stays with
 * `cell.update`. No timeout of its own; `fn` times out its own network calls.
 */
export function flight<T>(): Flight<T> {
  let current: Promise<T> | undefined;
  return {
    run(fn) {
      if (current) return current;
      const p = Promise.resolve().then(fn);
      current = p;
      const done = () => {
        if (current === p) current = undefined;
      };
      p.then(done, done);
      return p;
    },
  };
}

/** One flight per key: `run("github", fn)` and `run("slack", fn)` don't share. */
export function flights<K extends string, T>(): { run(key: K, fn: () => Promise<T>): Promise<T> } {
  const by = new Map<K, Flight<T>>();
  return {
    run(key, fn) {
      let f = by.get(key);
      if (!f) by.set(key, (f = flight<T>()));
      // ponytail: a flight per key ever used stays in the map; fine for a bounded key set (provider ids).
      return f.run(fn);
    },
  };
}

export type Mutex = { run<T>(fn: () => Promise<T>): Promise<T> };

/**
 * One at a time, in arrival order; each caller gets its own result. A failure releases it.
 * Don't take the same mutex inside itself (it waits forever). It stops overlap, not crashes:
 * work inside must be crash-safe on its own (e.g. a final cas as the commit).
 */
export function mutex(): Mutex {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run(fn) {
      const r = tail.then(fn);
      tail = r.then(clear, clear);
      return r;
    },
  };
}
