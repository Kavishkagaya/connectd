// L0: what a deployment target provides. Two parts: the Platform (one per deployment: env, outbound
// fetch, logs, connectd's own management database, and the atoms) and the Atom (one connection's
// state, single owner). Every target implements both (drivers/: memory, Durable Objects) and passes
// the same parity suites (drivers/parity.ts). Nothing above this file knows which one it runs on.

import { base64url, fromBase64url } from "./secrets.ts";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * One atomic element: one connection's state. Guarantees, on every platform:
 * - single owner: at most one live handler per atom name across the deployment;
 * - each store op is atomic; versions only go up, never repeat (no ABA on `cas`, even after delete or destroy);
 * - handlers may interleave at any await, so anything that races goes through `cas` or `take`;
 * - timers are durable and named (set again = replace) and fire at least once, at or after `at`;
 * - store and timers survive restarts and redeploys; nothing in memory does.
 * Values and timer payloads over `platform.limits.valueBytes` throw `LimitExceeded`.
 */
export interface Atom {
  readonly name: string;
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
}

/** One deployment, shared by every atom and the HTTP front door. */
export interface Platform {
  /** The deployed code's version: changes on every deploy. Stored state outlives it. */
  readonly version: string;
  now(): number;
  /** The deployment's configuration values, as the platform was given them. Read-only. */
  env(name: string): string | undefined;
  /** Outbound HTTP (providers, webhooks, event delivery). */
  fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
  log(level: Level, event: string, fields?: Record<string, Json>): void;
  /** Work that may outlive the request that started it. Its failure is logged, never thrown. */
  defer(work: Promise<unknown>): void;
  atoms: {
    /**
     * Call an atom's handler, creating the atom on first use. Args and result are Json and cross a
     * serialization boundary. What the handler throws reaches the caller; failing to reach the atom
     * throws `Unavailable` (retryable). Args or a result over `limits.callBytes` throw `LimitExceeded`.
     */
    call(name: string, method: string, args: Json): Promise<Json>;
    /** Wipe an atom's store and timers; its next call starts on an empty atom. */
    destroy(name: string): Promise<void>;
  };
  /** connectd's own management data. Fixed operations for connectd's needs, never exposed to user code. */
  db: Management;
  limits: Limits;
}

export type Level = "debug" | "info" | "warn" | "error";

/** Sizes in bytes of JSON-encoded data; the same on every platform's behaviour (memory enforces them too). */
export type Limits = { valueBytes: number; callBytes: number };

/**
 * The strictest production platform's limits (Durable Objects: a SQLite row caps at 2 MB, RPC
 * messages are larger), with room to spare. Every platform uses these, so what passes in memory
 * passes there. ponytail: one fixed pair; let a platform set its own when one is stricter.
 */
export const LIMITS: Limits = { valueBytes: 1 << 20, callBytes: 1 << 20 };

/** What the kernel gives back to the platform. Every event reaches an atom through this. */
export interface Handler {
  onCall(method: string, args: Json): Promise<Json>;
  onTimer(name: string, payload: Json): Promise<void>;
}

export type Program = (atom: Atom, platform: Platform) => Handler;

/** Thrown by `atoms.call` when the atom can't be reached (overloaded, network, reset). Safe to retry. */
export class Unavailable extends Error {
  override readonly name = "Unavailable";
}

/** Thrown when a value, a timer payload, or a call's args or result is over `platform.limits`. */
export class LimitExceeded extends Error {
  override readonly name = "LimitExceeded";
}

/** Byte size of a Json value as stored and sent; throws `LimitExceeded` over `max`. */
export function within(what: string, value: Json, max: number): string {
  const s = JSON.stringify(value);
  const n = new TextEncoder().encode(s).length;
  if (n > max) throw new LimitExceeded(`${what} is ${n} bytes, over the limit of ${max}`);
  return s;
}

// ---- The management database --------------------------------------------------------------------

/**
 * connectd's management data, one group per need. Each operation is implemented by every platform in
 * its own storage (D1, Postgres, memory) and covered by platform parity. A new need is a new named
 * operation here, never a generic query.
 */
export interface Management {
  /**
   * The connection index (#26): a copy of every connection's state and external ids, for listing,
   * search and webhook routing (#25). The atom is the source of truth; nothing secret is copied.
   */
  connections: {
    /** Insert, or replace unless the stored row has a higher version. `createdAt` is set on insert. */
    upsert(row: Omit<ConnectionRow, "createdAt">): Promise<void>;
    /** Ordered by (def, id). A bad cursor throws `BadCursor`. */
    list(q: ConnectionQuery): Promise<ConnectionPage>;
    /** Every connection of `def` with external id `key` = `value` (one Slack team can have several). */
    byExternal(def: string, key: string, value: string): Promise<ConnectionRow[]>;
  };
  // ponytail: no delete; connections are never deleted (revoked is terminal). Add one with a purge/GC.
}

export type ConnectionRow = {
  def: string;
  id: string;
  state: string;
  reason: string | null;
  /** From the definition's `external(metadata)`: Slack `teamId`, GitHub `id`, Google `sub`. */
  external: Record<string, string>;
  createdAt: number;
  updatedAt: number;
  /** The connection's store version when the row was copied; a lower one never overwrites a higher one. */
  version: number;
};

export type ConnectionQuery = {
  def?: string;
  state?: string;
  /** Substring of the id or of any external id, any case. */
  q?: string;
  external?: { key: string; value: string };
  /** From the previous page. */
  cursor?: string;
  /** Default `PAGE`, at most `MAX_PAGE`. */
  limit?: number;
};

/** `cursor` is null on the last page. */
export type ConnectionPage = { connections: ConnectionRow[]; cursor: string | null };

export const PAGE = 50;
export const MAX_PAGE = 200;

export class BadCursor extends Error {
  override readonly name = "BadCursor";
}

// Shared by the implementations: a cursor is the (def, id) of the last row, base64url JSON.

/** For implementations: fetch `limit + 1` rows ordered by (def, id); this cuts the page and makes the cursor. */
export function page(rows: ConnectionRow[], q: ConnectionQuery): ConnectionPage {
  const limit = q.limit ?? PAGE;
  const last = rows.length > limit ? rows[limit - 1] : undefined;
  return { connections: rows.slice(0, limit), cursor: last ? base64url(new TextEncoder().encode(JSON.stringify([last.def, last.id]))) : null };
}

/** The (def, id) a cursor continues after; throws `BadCursor`. */
export function after(cursor: string): [string, string] {
  try {
    const k = JSON.parse(new TextDecoder().decode(fromBase64url(cursor))) as unknown;
    if (Array.isArray(k) && k.length === 2 && k.every((s) => typeof s === "string")) return k as [string, string];
  } catch {}
  throw new BadCursor("bad cursor");
}

/** For implementations: `byExternal` as pages of `list`. */
export async function allPages(list: (q: ConnectionQuery) => Promise<ConnectionPage>, q: ConnectionQuery): Promise<ConnectionRow[]> {
  const rows: ConnectionRow[] = [];
  let cursor: string | null | undefined;
  do {
    const p = await list({ ...q, limit: MAX_PAGE, ...(cursor ? { cursor } : {}) });
    rows.push(...p.connections);
    cursor = p.cursor;
  } while (cursor);
  return rows;
}
