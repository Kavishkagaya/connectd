export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * What a driver gives the kernel, scoped to one instance (e.g. one connection).
 * Each store op is atomic. Handlers may interleave at any await, so the kernel
 * uses `cas`/`take` for anything that races (refresh, callbacks).
 */
export interface Driver {
  now(): number;
  store: {
    get(key: string): Promise<{ v: number; value: Json } | null>;
    put(key: string, value: Json, opts?: { ttlMs?: number }): Promise<void>;
    /** Write only if the current version is `expected` (null = key absent). */
    cas(key: string, expected: number | null, value: Json, opts?: { ttlMs?: number }): Promise<boolean>;
    /** Read and delete in one step: at most one caller gets the value. */
    take(key: string): Promise<Json | null>;
    delete(key: string): Promise<void>;
  };
  timer: {
    /** Durable named timer; setting an existing name replaces it. */
    set(name: string, at: number, payload?: Json): Promise<void>;
    cancel(name: string): Promise<void>;
  };
  /** Call another instance's handler. Args and result cross a serialization boundary. */
  call(instance: string, method: string, args: Json): Promise<Json>;
}

/** What the kernel gives back to the driver. Every event reaches an instance through this. */
export interface Handler {
  onCall(method: string, args: Json): Promise<Json>;
  onTimer(name: string, payload: Json): Promise<void>;
}

export type Program = (driver: Driver, instance: string) => Handler;
