import { DurableObject } from "cloudflare:workers";
import type { Driver, Handler, Json, Program } from "../driver.ts";

/**
 * Durable Object driver. One DO class runs a Program; each instance key is one DO (idFromName).
 *
 *   export class Connection extends durableObject(program, { binding: "CONNECTION" }) {}
 *
 * Every SQL statement below runs synchronously with no await in between, so each store op
 * is atomic against other events on the same DO.
 */
/** What `durableObject()` returns, named so its declaration can be emitted (the base class has protected members). */
export type ProgramDO = new (
  ctx: DurableObjectState,
  env: Record<string, unknown>,
) => DurableObject<Record<string, unknown>> & { readonly handler: Handler; onCall(method: string, args: Json): Promise<Json> };

export function durableObject(program: Program, opts: { binding: string; now?: () => number }): ProgramDO {
  const now = opts.now ?? Date.now;

  return class extends DurableObject<Record<string, unknown>> {
    readonly handler: Handler;

    constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
      super(ctx, env);
      const sql = ctx.storage.sql;
      sql.exec(`
        CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, v INTEGER NOT NULL, value TEXT NOT NULL, expires_at INTEGER);
        CREATE INDEX IF NOT EXISTS kv_expires ON kv (expires_at) WHERE expires_at IS NOT NULL;
        CREATE TABLE IF NOT EXISTS timers (name TEXT PRIMARY KEY, at INTEGER NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS seq (id INTEGER PRIMARY KEY CHECK (id = 0), n INTEGER NOT NULL);
        INSERT OR IGNORE INTO seq VALUES (0, 0);
      `);

      const row = (key: string) =>
        sql
          .exec<{ v: number; value: string }>(
            "SELECT v, value FROM kv WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)",
            key,
            now(),
          )
          .toArray()[0];
      const write = (key: string, value: Json, ttlMs?: number) => {
        const t = now();
        // ponytail: sweep expired rows on every write so abandoned handshakes don't pile up.
        sql.exec("DELETE FROM kv WHERE expires_at <= ?", t);
        // Versions come from one counter per DO, so they never repeat (no ABA on cas).
        const v = sql.exec<{ n: number }>("UPDATE seq SET n = n + 1 WHERE id = 0 RETURNING n").one().n;
        sql.exec(
          "INSERT OR REPLACE INTO kv (key, v, value, expires_at) VALUES (?, ?, ?, ?)",
          key,
          v,
          JSON.stringify(value),
          ttlMs === undefined ? null : t + ttlMs,
        );
      };
      const rearm = () => {
        const next = sql.exec<{ at: number | null }>("SELECT min(at) AS at FROM timers").one().at;
        return next === null ? ctx.storage.deleteAlarm() : ctx.storage.setAlarm(next);
      };

      const driver: Driver = {
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
            sql.exec("INSERT OR REPLACE INTO timers VALUES (?, ?, ?)", name, at, JSON.stringify(payload));
            await rearm();
          },
          async cancel(name) {
            sql.exec("DELETE FROM timers WHERE name = ?", name);
            await rearm();
          },
        },
        call: (instance, method, args) => {
          const ns = env[opts.binding] as DurableObjectNamespace;
          const stub = ns.get(ns.idFromName(instance)) as unknown as Handler;
          return stub.onCall(method, args);
        },
      };

      if (ctx.id.name === undefined) throw new Error("durableObject: instances must be created with idFromName");
      this.handler = program(driver, ctx.id.name);
      this.#fire = async () => {
        for (;;) {
          const t = sql
            .exec<{ name: string; payload: string }>(
              "DELETE FROM timers WHERE name = (SELECT name FROM timers WHERE at <= ? ORDER BY at LIMIT 1) RETURNING name, payload",
              now(),
            )
            .toArray()[0];
          if (!t) return rearm();
          await this.handler.onTimer(t.name, JSON.parse(t.payload)).catch((e) => console.error("timer", t.name, e));
        }
      };
    }

    readonly #fire: () => Promise<void>;

    /** RPC entry point: every call into this instance comes through here. */
    onCall(method: string, args: Json): Promise<Json> {
      return this.handler.onCall(method, args);
    }

    override alarm() {
      return this.#fire();
    }
  };
}
