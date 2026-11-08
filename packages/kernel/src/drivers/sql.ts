import { after, allPages, type AccountRow, type ConnectionRow, type KeyRow, type Management, PAGE, page, type PasskeyRow } from "../platform.ts";

/**
 * The management database in SQL (schema: `migrations/`), for any SQLite: D1 on Cloudflare
 * (drivers/do.ts), `bun:sqlite` / `node:sqlite` in dev (drivers/sqlite.ts). One implementation, so
 * dev's database behaves like production's.
 */

type Arg = string | number | null;
export type Statement = { sql: string; args: Arg[] };

/** What a SQLite gives this file. `batch` runs its statements in one transaction. */
export type Sql = {
  all<T>(sql: string, args: Arg[]): Promise<T[]>;
  run(sql: string, args: Arg[]): Promise<{ changes: number }>;
  batch(statements: Statement[]): Promise<void>;
};

type ConnRow = { def: string; id: string; state: string; reason: string | null; external: string; created_at: number; updated_at: number; version: number };
type KeyDb = { id: string; kind: string; name: string; value: string; previous: string | null; previous_until: number | null; created_at: number; rolled_at: number | null; revoked_at: number | null; last_used_at: number | null };
type AccountDb = { username: string; password: string | null; sessions: number; created_at: number };
type PasskeyDb = { id: string; username: string; public_key: string; alg: number; counter: number; name: string; created_at: number; last_used_at: number | null };

const key = (r: KeyDb): KeyRow => ({
  id: r.id,
  kind: r.kind as KeyRow["kind"],
  name: r.name,
  value: r.value,
  previous: r.previous,
  previousUntil: r.previous_until,
  createdAt: r.created_at,
  rolledAt: r.rolled_at,
  revokedAt: r.revoked_at,
  lastUsedAt: r.last_used_at,
});
const account = (r: AccountDb): AccountRow => ({ username: r.username, password: r.password, sessions: r.sessions, createdAt: r.created_at });
const passkey = (r: PasskeyDb): PasskeyRow => ({
  id: r.id,
  username: r.username,
  publicKey: r.public_key,
  alg: r.alg,
  counter: r.counter,
  name: r.name,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
});

export function sqlDb(db: Sql): Management {
  const one = async <T>(sql: string, args: Arg[]) => (await db.all<T>(sql, args))[0] ?? null;

  const list: Management["connections"]["list"] = async (q) => {
    // Only the clauses asked for, so SQLite picks the matching index (external lookups start from connection_external).
    const where: string[] = [];
    const args: Arg[] = [];
    const and = (sql: string, ...a: Arg[]) => (where.push(sql), args.push(...a));
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
    const results = await db.all<ConnRow>(`SELECT * FROM connections c ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY c.def, c.id LIMIT ?`, [...args, (q.limit ?? PAGE) + 1]);
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

  const live = (id: string) => one<KeyDb>("SELECT * FROM keys WHERE id = ?1 AND revoked_at IS NULL", [id]);

  return {
    connections: {
      async upsert(r) {
        const conn = "(SELECT version FROM connections WHERE def = ?1 AND id = ?2) = ?3";
        // One batch is one transaction. The external pairs follow the row only if this write won.
        await db.batch([
          {
            sql: `INSERT INTO connections (def, id, state, reason, external, created_at, updated_at, version) VALUES (?1, ?2, ?4, ?5, ?6, ?7, ?7, ?3)
               ON CONFLICT (def, id) DO UPDATE SET state = excluded.state, reason = excluded.reason, external = excluded.external,
                 updated_at = excluded.updated_at, version = excluded.version
               WHERE excluded.version >= connections.version`,
            args: [r.def, r.id, r.version, r.state, r.reason, JSON.stringify(r.external), r.updatedAt],
          },
          { sql: `DELETE FROM connection_external WHERE def = ?1 AND id = ?2 AND ${conn}`, args: [r.def, r.id, r.version] },
          {
            sql: `INSERT OR IGNORE INTO connection_external (def, key, value, id)
               SELECT c.def, j.key, j.value, c.id FROM connections c, json_each(c.external) j WHERE c.def = ?1 AND c.id = ?2 AND c.version = ?3`,
            args: [r.def, r.id, r.version],
          },
        ]);
      },
      list,
      byExternal: (def, k, value) => allPages(list, { def, external: { key: k, value } }),
    },

    keys: {
      async create(r) {
        const { changes } = await db.run(
          `INSERT OR IGNORE INTO keys (id, kind, name, value, previous, previous_until, created_at, rolled_at, revoked_at, last_used_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
          [r.id, r.kind, r.name, r.value, r.previous, r.previousUntil, r.createdAt, r.rolledAt, r.revokedAt, r.lastUsedAt],
        );
        return changes > 0;
      },
      get: async (id) => {
        const r = await one<KeyDb>("SELECT * FROM keys WHERE id = ?1", [id]);
        return r && key(r);
      },
      list: async () => (await db.all<KeyDb>("SELECT * FROM keys ORDER BY created_at, id", [])).map(key),
      async roll(id, value, until, at) {
        const { changes } = await db.run(
          "UPDATE keys SET previous = CASE WHEN ?3 > ?4 THEN value END, previous_until = CASE WHEN ?3 > ?4 THEN ?3 END, value = ?2, rolled_at = ?4 WHERE id = ?1 AND revoked_at IS NULL",
          [id, value, until, at],
        );
        const r = changes ? await live(id) : null;
        return r && key(r);
      },
      async revoke(id, at) {
        const { changes } = await db.run("UPDATE keys SET revoked_at = ?2 WHERE id = ?1 AND revoked_at IS NULL", [id, at]);
        const r = changes ? await one<KeyDb>("SELECT * FROM keys WHERE id = ?1", [id]) : null;
        return r && key(r);
      },
      async used(id, at) {
        await db.run("UPDATE keys SET last_used_at = ?2 WHERE id = ?1 AND (last_used_at IS NULL OR last_used_at < ?2)", [id, at]);
      },
    },

    accounts: {
      async create(r) {
        const { changes } = await db.run("INSERT OR IGNORE INTO accounts (username, password, sessions, created_at) VALUES (?1, ?2, ?3, ?4)", [r.username, r.password, r.sessions, r.createdAt]);
        return changes > 0;
      },
      get: async (u) => {
        const r = await one<AccountDb>("SELECT * FROM accounts WHERE username = ?1", [u]);
        return r && account(r);
      },
      list: async () => (await db.all<AccountDb>("SELECT * FROM accounts ORDER BY created_at, username", [])).map(account),
      async password(u, hash) {
        return (await db.run("UPDATE accounts SET password = ?2 WHERE username = ?1", [u, hash])).changes > 0;
      },
      async signOut(u) {
        if (!(await db.run("UPDATE accounts SET sessions = sessions + 1 WHERE username = ?1", [u])).changes) return null;
        return (await one<{ sessions: number }>("SELECT sessions FROM accounts WHERE username = ?1", [u]))?.sessions ?? null;
      },
      async delete(u) {
        const had = await one<AccountDb>("SELECT * FROM accounts WHERE username = ?1", [u]);
        await db.batch([
          { sql: "DELETE FROM passkeys WHERE username = ?1", args: [u] },
          { sql: "DELETE FROM accounts WHERE username = ?1", args: [u] },
        ]);
        return !!had;
      },
    },

    passkeys: {
      async add(r) {
        const { changes } = await db.run(
          "INSERT OR IGNORE INTO passkeys (id, username, public_key, alg, counter, name, created_at, last_used_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
          [r.id, r.username, r.publicKey, r.alg, r.counter, r.name, r.createdAt, r.lastUsedAt],
        );
        return changes > 0;
      },
      get: async (id) => {
        const r = await one<PasskeyDb>("SELECT * FROM passkeys WHERE id = ?1", [id]);
        return r && passkey(r);
      },
      list: async (u) => (await db.all<PasskeyDb>("SELECT * FROM passkeys WHERE username = ?1 ORDER BY created_at, id", [u])).map(passkey),
      async used(id, counter, at) {
        await db.run("UPDATE passkeys SET counter = ?2, last_used_at = ?3 WHERE id = ?1", [id, counter, at]);
      },
      async delete(id) {
        return (await db.run("DELETE FROM passkeys WHERE id = ?1", [id])).changes > 0;
      },
    },

    nonces: {
      async claim(nonce, expiresAt, now) {
        // ponytail: expired nonces go on each claim (one indexed delete); a scheduled sweep if claims get hot.
        await db.run("DELETE FROM nonces WHERE expires_at <= ?1", [now]);
        return (await db.run("INSERT OR IGNORE INTO nonces (nonce, expires_at) VALUES (?1, ?2)", [nonce, expiresAt])).changes > 0;
      },
    },
  };
}
