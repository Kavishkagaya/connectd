import { env } from "cloudflare:workers";
import type { State } from "@connectd/connections";
import type { Handler } from "@connectd/kernel";
import { durableObject } from "@connectd/kernel/do";
import { after, type Index, LIMIT, page, type Row } from "./directory.ts";
import type { Runtime } from "./runtime.ts";

/**
 * The runtime on Cloudflare: one DO class for every connection, and the Worker's fetch in front.
 *
 *   const cf = cloudflare(runtime({ definitions, settings }), { binding: "CONNECTION" });
 *   export class Connection extends cf.ConnectionDO {}
 *   export default { fetch: cf.fetch };
 */
export function cloudflare(rt: Runtime, opts: { binding: string; now?: () => number }) {
  return {
    ConnectionDO: durableObject(rt.program, opts),
    fetch(req: Request, env: Record<string, unknown>) {
      const ns = env[opts.binding] as DurableObjectNamespace;
      return rt.fetch(req, (i, m, a) => (ns.get(ns.idFromName(i)) as unknown as Handler).onCall(m, a));
    },
  };
}

type D1Row = { def: string; id: string; state: State; reason: string | null; external: string; created_at: number; updated_at: number; version: number };

/**
 * The connection index on D1 (schema: `migrations/0001_index.sql`). `binding` is read from the
 * environment on each use, so the same index works in the Worker and in the ConnectionDO.
 *
 *   runtime({ ..., extensions: [directory(d1Index("INDEX"))] })
 */
export function d1Index(binding: string): Index {
  const db = () => (env as unknown as Record<string, D1Database>)[binding] as D1Database;
  return {
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

    async list(q) {
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
        .bind(...args, (q.limit ?? LIMIT) + 1)
        .all<D1Row>();
      const rows: Row[] = results.map((r) => ({
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
    },
  };
}
