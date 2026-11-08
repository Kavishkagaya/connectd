import type { Management } from "../platform.ts";
import { type Sql, sqlDb } from "./sql.ts";

/**
 * The management database on a local SQLite file (`connectd dev`: `.connectd/dev.db`), so keys and
 * accounts outlive restarts and `--reset`. The same SQL and migrations as D1 (drivers/sql.ts). The
 * caller opens the file (`bun:sqlite`'s Database or `node:sqlite`'s DatabaseSync, both fit) and
 * reads the migrations; this file imports neither, so the kernel stays runtime-free.
 */

type Stmt = { all(...args: unknown[]): unknown[]; run(...args: unknown[]): { changes: number | bigint } };
/** What both `bun:sqlite` and `node:sqlite` databases have. */
export type SyncSqlite = { prepare(sql: string): Stmt; exec(sql: string): unknown };

/** A migration file: its name (`0001_index.sql`, applied in name order) and text. */
export type Migration = { name: string; sql: string };

const changes = (r: { changes: number | bigint }) => Number(r.changes);

/** Apply the migrations not yet applied (by name), each in its own transaction. Returns the names applied. */
export function migrate(db: SyncSqlite, migrations: Migration[]): string[] {
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const done = new Set((db.prepare("SELECT name FROM _migrations").all() as { name: string }[]).map((r) => r.name));
  const applied: string[] = [];
  for (const m of [...migrations].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (done.has(m.name)) continue;
    db.exec("BEGIN");
    try {
      db.exec(m.sql);
      db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?1, ?2)").run(m.name, Date.now());
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${m.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
    applied.push(m.name);
  }
  return applied;
}

/** The management database on `db`, migrated first. */
export function sqliteDb(db: SyncSqlite, migrations: Migration[]): Management {
  migrate(db, migrations);
  const sql: Sql = {
    all: async <T,>(q: string, args: unknown[]) => db.prepare(q).all(...args) as T[],
    run: async (q, args) => ({ changes: changes(db.prepare(q).run(...args)) }),
    // Synchronous from BEGIN to COMMIT: nothing else runs in between.
    async batch(statements) {
      db.exec("BEGIN");
      try {
        for (const s of statements) db.prepare(s.sql).run(...s.args);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return sqlDb(sql);
}

/** Wipe what dev's `--reset` drops: the connection index (connections start over), not keys or accounts. */
export function resetConnections(db: SyncSqlite) {
  db.exec("DELETE FROM connection_external; DELETE FROM connections;");
}

/** Where the migrations ship: `<kernel>/migrations`, next to `src/drivers` (and `dist/drivers` once packed). */
export const MIGRATIONS_DIR = new URL("../../migrations/", import.meta.url);
