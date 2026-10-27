import { DurableObject } from "cloudflare:workers";
import {
  after,
  allPages,
  type Atom,
  type ConnectionRow,
  type Handler,
  type Json,
  LIMITS,
  type Management,
  PAGE,
  page,
  type Platform,
  type Program,
  Unavailable,
  within,
} from "../platform.ts";

export { LIMITS };

/**
 * The Cloudflare platform: one Durable Object per atom (`idFromName`, so single owner by
 * construction), D1 for the management database, the Worker's env and outbound fetch.
 *
 *   export class Connection extends durableObject(program, { binding: "CONNECTION", db: "INDEX" }) {}
 *   // the Worker's fetch: cloudflarePlatform(env, opts, (p) => ctx.waitUntil(p))
 *
 * Every SQL statement in an atom runs synchronously with no await in between, so each store op is
 * atomic against other events on the same DO.
 */

export type CloudflareOptions = {
  /** The Durable Object namespace binding the atoms live in. */
  binding: string;
  /** The D1 binding of the management database (schema: `migrations/`). */
  db?: string;
  /** A fake clock for tests. Default `Date.now`. */
  now?: () => number;
  /** A fake outbound fetch for tests. Default: the Worker's. */
  fetch?: Platform["fetch"];
};

/** The binding `connectd deploy` adds (`version_metadata`): the deployed version's id. */
export const VERSION_BINDING = "CF_VERSION_METADATA";

type Env = Record<string, unknown>;
/** The platform passes the atom's name on every call: a DO woken by an alarm alone has no name to read from its id. */
type Stub = { onCall(method: string, args: Json, name: string): Promise<Json>; destroy(name: string): Promise<void> };

/** The platform in a Worker or a DO: `waitUntil` is the request's (`ctx.waitUntil`). */
export function cloudflarePlatform(env: Env, opts: CloudflareOptions, waitUntil?: (p: Promise<unknown>) => void): Platform {
  const now = opts.now ?? Date.now;
  const stub = (name: string) => {
    const ns = env[opts.binding] as DurableObjectNamespace;
    return ns.get(ns.idFromName(name)) as unknown as Stub;
  };
  const log: Platform["log"] = (level, event, fields) => console[level]({ event, ...fields });
  // Cloudflare marks failures to reach a DO (overloaded, reset, network) with these.
  const unreachable = (e: unknown) => {
    const x = e as { retryable?: boolean; overloaded?: boolean } | null;
    return !!x && typeof x === "object" && (x.retryable === true || x.overloaded === true);
  };
  const reach = async <T,>(name: string, f: (s: Stub) => Promise<T>): Promise<T> => {
    try {
      return await f(stub(name));
    } catch (e) {
      if (unreachable(e)) throw new Unavailable(`atom ${name}: ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    }
  };
  return {
    version: (env[VERSION_BINDING] as { id?: string } | undefined)?.id ?? "unknown",
    now,
    env: (name) => (typeof env[name] === "string" ? (env[name] as string) : undefined),
    // Wrapped: workerd's fetch throws "Illegal invocation" when called as a method of another object.
    fetch: opts.fetch ?? ((input, init) => fetch(input, init)),
    log,
    defer(work) {
      const p = work.catch((e) => log("error", "platform.defer.failed", { error: e instanceof Error ? e.message : String(e) }));
      waitUntil?.(p);
    },
    atoms: {
      async call(name, method, args) {
        within("call args", args, LIMITS.callBytes);
        const out = await reach(name, (s) => s.onCall(method, args, name));
        within("call result", out, LIMITS.callBytes);
        return out;
      },
      destroy: (name) => reach(name, (s) => s.destroy(name)),
    },
    db: d1(() => {
      const db = opts.db ? (env[opts.db] as D1Database | undefined) : undefined;
      if (!db) throw new Error(`cloudflare platform: no D1 binding ${opts.db ?? "(opts.db not set)"}`);
      return db;
    }),
    limits: LIMITS,
  };
}

/** What `durableObject()` returns, named so its declaration can be emitted (the base class has protected members). */
export type ProgramDO = new (ctx: DurableObjectState, env: Env) => DurableObject<Env> & Stub & { readonly handler: Handler };

export function durableObject(program: Program, opts: CloudflareOptions): ProgramDO {
  const now = opts.now ?? Date.now;

  return class extends DurableObject<Env> {
    #handler: Handler | undefined;
    readonly #fresh: () => Handler;
    readonly #named: (name: string) => Promise<void>;
    readonly #fire: () => Promise<void>;
    readonly #wipe: () => Promise<void>;

    /** Built once the atom's name is known. */
    get handler(): Handler {
      return (this.#handler ??= this.#fresh());
    }

    constructor(ctx: DurableObjectState, env: Env) {
      super(ctx, env);
      const sql = ctx.storage.sql;
      sql.exec(`
        CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, v INTEGER NOT NULL, value TEXT NOT NULL, expires_at INTEGER);
        CREATE INDEX IF NOT EXISTS kv_expires ON kv (expires_at) WHERE expires_at IS NOT NULL;
        CREATE TABLE IF NOT EXISTS timers (name TEXT PRIMARY KEY, at INTEGER NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS seq (id INTEGER PRIMARY KEY CHECK (id = 0), n INTEGER NOT NULL);
        INSERT OR IGNORE INTO seq VALUES (0, 0);
        CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      `);
      // The atom's name, kept: an alarm can wake a DO from its bare id, which carries no name. A DO
      // from before names were kept learns it on its next call (every call carries it).
      let name = ctx.id.name ?? sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'name'").toArray()[0]?.v;
      const keep = (n: string) => sql.exec("INSERT OR IGNORE INTO meta VALUES ('name', ?)", n).rowsWritten > 0;
      if (ctx.id.name !== undefined) keep(ctx.id.name);

      const row = (key: string) =>
        sql
          .exec<{ v: number; value: string }>("SELECT v, value FROM kv WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)", key, now())
          .toArray()[0];
      const write = (key: string, value: Json, ttlMs?: number) => {
        const json = within(`value ${key}`, value, LIMITS.valueBytes);
        const t = now();
        // ponytail: sweep expired rows on every write so abandoned handshakes don't pile up.
        sql.exec("DELETE FROM kv WHERE expires_at <= ?", t);
        // Versions come from one counter per DO, so they never repeat (no ABA on cas).
        const v = sql.exec<{ n: number }>("UPDATE seq SET n = n + 1 WHERE id = 0 RETURNING n").one().n;
        sql.exec("INSERT OR REPLACE INTO kv (key, v, value, expires_at) VALUES (?, ?, ?, ?)", key, v, json, ttlMs === undefined ? null : t + ttlMs);
      };
      const rearm = () => {
        const next = sql.exec<{ at: number | null }>("SELECT min(at) AS at FROM timers").one().at;
        return next === null ? ctx.storage.deleteAlarm() : ctx.storage.setAlarm(next);
      };

      const atom: Omit<Atom, "name"> = {
        now,
        store: {
          async get(key) {
            const r = row(key);
            return r ? { v: r.v, value: JSON.parse(r.value) } : null;
          },
          async put(key, value, o) {
            write(key, value, o?.ttlMs);
          },
          async cas(key, expected, value, o) {
            if ((row(key)?.v ?? null) !== expected) return false;
            write(key, value, o?.ttlMs);
            return true;
          },
          async take(key) {
            const r = row(key);
            sql.exec("DELETE FROM kv WHERE key = ?", key);
            return r ? JSON.parse(r.value) : null;
          },
          async delete(key) {
            sql.exec("DELETE FROM kv WHERE key = ?", key);
          },
        },
        timer: {
          async set(name, at, payload = null) {
            sql.exec("INSERT OR REPLACE INTO timers VALUES (?, ?, ?)", name, at, within(`timer ${name} payload`, payload, LIMITS.valueBytes));
            await rearm();
          },
          async cancel(name) {
            sql.exec("DELETE FROM timers WHERE name = ?", name);
            await rearm();
          },
        },
      };
      const platform = cloudflarePlatform(env, opts, (p) => ctx.waitUntil(p));
      this.#fresh = () => {
        if (name === undefined) throw new Error("durableObject: atoms must be created with idFromName");
        return program({ name, ...atom }, platform);
      };
      if (name !== undefined) this.#handler = this.#fresh();
      this.#named = async (n) => {
        if (name !== undefined) return;
        name = n;
        // Its timers waited for the name (below): arm them now.
        if (keep(n)) await rearm();
      };
      this.#fire = async () => {
        if (name === undefined) {
          // Woken by an alarm before it ever learned its name: the timers stay stored until the next call names it.
          platform.log("warn", "platform.timer.unnamed", { id: ctx.id.toString() });
          return;
        }
        for (;;) {
          const t = sql
            .exec<{ name: string; payload: string }>(
              "DELETE FROM timers WHERE name = (SELECT name FROM timers WHERE at <= ? ORDER BY at LIMIT 1) RETURNING name, payload",
              now(),
            )
            .toArray()[0];
          if (!t) return rearm();
          await this.handler
            .onTimer(t.name, JSON.parse(t.payload))
            .catch((e) => platform.log("error", "platform.timer.threw", { timer: t.name, error: e instanceof Error ? e.message : String(e) }));
        }
      };
      // The version counter stays: versions never repeat, even across a destroy.
      this.#wipe = async () => {
        sql.exec("DELETE FROM kv; DELETE FROM timers;");
        await ctx.storage.deleteAlarm();
      };
    }

    /** RPC entry point: every call into this atom comes through here. */
    async onCall(method: string, args: Json, name: string): Promise<Json> {
      await this.#named(name);
      return this.handler.onCall(method, args);
    }

    /** `platform.atoms.destroy`: an empty store, no timers, a fresh handler. */
    async destroy(name: string): Promise<void> {
      await this.#named(name);
      await this.#wipe();
      this.#handler = this.#fresh();
    }

    override alarm() {
      return this.#fire();
    }
  };
}

type D1Row = { def: string; id: string; state: string; reason: string | null; external: string; created_at: number; updated_at: number; version: number };

/** The management database on D1 (schema: `migrations/`). `db` is read on each use, from the env the platform was built with. */
function d1(db: () => D1Database): Management {
  const list: Management["connections"]["list"] = async (q) => {
    // Only the clauses asked for, so SQLite picks the matching index (external lookups start from connection_external).
    const where: string[] = [];
    const args: (string | number)[] = [];
    const and = (sql: string, ...a: (string | number)[]) => (where.push(sql), args.push(...a));
    if (q.def) and("c.def = ?", q.def);
    if (q.state) and("c.state = ?", q.state);
    if (q.external) and("(c.def, c.id) IN (SELECT def, id FROM connection_external WHERE key = ? AND value = ?)", q.external.key, q.external.value);
    // ponytail: substring search scans; add FTS5 over id + external values when lists get big.
    if (q.q)
      and(
        "(instr(lower(c.id), lower(?)) > 0 OR EXISTS (SELECT 1 FROM connection_external x WHERE x.def = c.def AND x.id = c.id AND instr(lower(x.value), lower(?)) > 0))",
        q.q,
        q.q,
      );
    if (q.cursor) and("(c.def, c.id) > (?, ?)", ...after(q.cursor));
    const { results } = await db()
      .prepare(`SELECT * FROM connections c ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY c.def, c.id LIMIT ?`)
      .bind(...args, (q.limit ?? PAGE) + 1)
      .all<D1Row>();
    const rows: ConnectionRow[] = results.map((r) => ({
      def: r.def,
      id: r.id,
      state: r.state,
      reason: r.reason,
      external: JSON.parse(r.external) as Record<string, string>,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      version: r.version,
    }));
    return page(rows, q);
  };
  return {
    connections: {
      async upsert(r) {
        const conn = "(SELECT version FROM connections WHERE def = ?1 AND id = ?2) = ?3";
        // One batch is one transaction. The external pairs follow the row only if this write won.
        await db().batch([
          db()
            .prepare(
              `INSERT INTO connections (def, id, state, reason, external, created_at, updated_at, version) VALUES (?1, ?2, ?4, ?5, ?6, ?7, ?7, ?3)
               ON CONFLICT (def, id) DO UPDATE SET state = excluded.state, reason = excluded.reason, external = excluded.external,
                 updated_at = excluded.updated_at, version = excluded.version
               WHERE excluded.version >= connections.version`,
            )
            .bind(r.def, r.id, r.version, r.state, r.reason, JSON.stringify(r.external), r.updatedAt),
          db().prepare(`DELETE FROM connection_external WHERE def = ?1 AND id = ?2 AND ${conn}`).bind(r.def, r.id, r.version),
          db()
            .prepare(
              `INSERT OR IGNORE INTO connection_external (def, key, value, id)
               SELECT c.def, j.key, j.value, c.id FROM connections c, json_each(c.external) j WHERE c.def = ?1 AND c.id = ?2 AND c.version = ?3`,
            )
            .bind(r.def, r.id, r.version),
        ]);
      },
      list,
      byExternal: (def, key, value) => allPages(list, { def, external: { key, value } }),
    },
  };
}
