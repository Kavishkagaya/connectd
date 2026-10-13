import { base64url, fromBase64url, type Json, type State } from "@openconnect/kernel";
import { Fail } from "./host.ts";
import type { Extension } from "./runtime.ts";

/**
 * The connection index (#26): a copy of every connection's state and external ids, for listing,
 * search and lookup by external id (webhooks route by it, #25). The ConnectionDO is the source of
 * truth; each one upserts its own row after every method and timer, versioned so a stale write
 * never wins. Nothing secret is copied.
 *
 *   const index = memoryIndex(); // or d1Index(env.INDEX) from `/cloudflare`
 *   runtime({ definitions, settings, extensions: [directory(index)] });
 */

export type Row = {
  def: string;
  id: string;
  state: State;
  reason: string | null;
  /** From the definition's `external(metadata)`: Slack `teamId`, GitHub `id`, Google `sub`. */
  external: Record<string, string>;
  createdAt: number;
  updatedAt: number;
  /** The connection's store version when the row was copied; a lower one never overwrites a higher one. */
  version: number;
};

export type Query = {
  def?: string;
  state?: string;
  /** Substring of the id or of any external id. */
  q?: string;
  external?: { key: string; value: string };
  /** From the previous page. */
  cursor?: string;
  limit?: number;
};

/** Ordered by (def, id). `cursor` is null on the last page. */
export type Page = { connections: Row[]; cursor: string | null };

export interface Index {
  /** Insert, or replace unless the stored row has a higher version. `createdAt` is set on insert. */
  upsert(row: Omit<Row, "createdAt">): Promise<void>;
  list(q: Query): Promise<Page>;
}
// ponytail: no delete; connections are never deleted (revoked is terminal). Add one with a purge/GC.

export const LIMIT = 50;
const MAX_LIMIT = 200;

/** For Index implementations: fetch `limit + 1` rows, this cuts the page and makes the cursor. */
export function page(rows: Row[], q: Query): Page {
  const limit = q.limit ?? LIMIT;
  const last = rows.length > limit ? rows[limit - 1] : undefined;
  return { connections: rows.slice(0, limit), cursor: last ? base64url(new TextEncoder().encode(JSON.stringify([last.def, last.id]))) : null };
}

/** The (def, id) a cursor continues after. */
export function after(cursor: string): [string, string] {
  try {
    const k = JSON.parse(new TextDecoder().decode(fromBase64url(cursor))) as unknown;
    if (Array.isArray(k) && k.length === 2 && k.every((s) => typeof s === "string")) return k as [string, string];
  } catch {}
  throw new Fail("bad_request", 400, "bad cursor");
}

/** In-memory Index for tests and dev. */
export function memoryIndex(): Index {
  const rows = new Map<string, Row>();
  const key = (def: string, id: string) => JSON.stringify([def, id]);
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return {
    async upsert(r) {
      const cur = rows.get(key(r.def, r.id));
      // Equal versions carry equal data, so they rewrite (that's how `index.sync` repairs a row).
      if (cur && cur.version > r.version) return;
      rows.set(key(r.def, r.id), structuredClone({ ...r, createdAt: cur?.createdAt ?? r.updatedAt }));
    },
    async list(q) {
      const from = q.cursor ? after(q.cursor) : null;
      const needle = q.q?.toLowerCase();
      const hits = [...rows.values()]
        .filter(
          (r) =>
            (!q.def || r.def === q.def) &&
            (!q.state || r.state === q.state) &&
            (!q.external || (Object.hasOwn(r.external, q.external.key) && r.external[q.external.key] === q.external.value)) &&
            (!needle || [r.id, ...Object.values(r.external)].some((s) => s.toLowerCase().includes(needle))) &&
            (!from || cmp(r.def, from[0]) > 0 || (r.def === from[0] && cmp(r.id, from[1]) > 0)),
        )
        .sort((a, b) => cmp(a.def, b.def) || cmp(a.id, b.id));
      return page(structuredClone(hits.slice(0, (q.limit ?? LIMIT) + 1)), q);
    },
  };
}

/** `GET /connections?def=&state=&q=&external=key:value&cursor=&limit=`, served by the built-in `connections` route. */
export async function listing(req: Request, index: Index): Promise<Response> {
  if (req.method !== "GET") throw new Fail("method_not_allowed", 405, "GET only");
  const p = new URL(req.url).searchParams;
  const opt = (n: string) => p.get(n) || undefined;
  const limit = Number(p.get("limit") ?? LIMIT);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new Fail("bad_request", 400, `limit is 1-${MAX_LIMIT}`);
  const ext = opt("external");
  const colon = ext?.indexOf(":") ?? -1;
  if (ext && colon < 1) throw new Fail("bad_request", 400, "external is key:value");
  return Response.json(
    await index.list({
      def: opt("def"),
      state: opt("state"),
      q: opt("q"),
      cursor: opt("cursor"),
      limit,
      ...(ext ? { external: { key: ext.slice(0, colon), value: ext.slice(colon + 1) } } : {}),
    }),
  );
}

/** Every connection of `def` with external id `key` = `value` (one Slack team can have several). For webhooks (#25): `api.index`. */
export async function findByExternal(index: Index, def: string, key: string, value: string): Promise<Row[]> {
  const rows: Row[] = [];
  let cursor: string | null | undefined;
  do {
    const p = await index.list({ def, external: { key, value }, limit: MAX_LIMIT, ...(cursor ? { cursor } : {}) });
    rows.push(...p.connections);
    cursor = p.cursor;
  } while (cursor);
  return rows;
}

/**
 * The index as an extension: each connection keeps its row current from `after`, `index.sync`
 * re-copies it on demand, and the runtime hands `index` to routes as `api.index`.
 */
export function directory(index: Index): Extension {
  return {
    index,
    connection: ({ d, def, id, bound }) => {
      // What the index holds for this connection, as far as this instance knows: the version it
      // reflects, and the content last written (null until a write succeeds here).
      let synced = -1;
      let written: { state: string; reason: string | null; external: Record<string, string> } | null = null;
      let inflight = 0;

      function externalOf(meta: Json): Record<string, string> {
        if (meta === null || !def.external) return {};
        try {
          return def.external(meta) as Record<string, string>;
        } catch (e) {
          // A throwing definition hook mustn't stop the row from tracking state.
          console.error("external hook", def.id, id, e);
          return written?.external ?? {};
        }
      }

      async function sync(force: boolean) {
        // "meta" is bind's key (define.ts). It's written after the record, so reading it first
        // means a read torn by a concurrent re-auth gets a lower version than the read after it.
        const meta = await d.store.get("meta");
        // Both versions come from one counter per instance, so the max orders the pair.
        // Most calls (token, status, proxied requests) change nothing: stop before decrypting.
        if (!force && Math.max((await bound.conn.version()) ?? 0, meta?.v ?? 0) === synced) return;
        const s = await bound.conn.read();
        if (!s) return; // nothing was ever created (a failed first connect)
        const version = Math.max(s.v, meta?.v ?? 0);
        const row = { state: s.state, reason: s.reason ?? null, external: externalOf(meta?.value ?? null) };
        // A refresh bumps the version but nothing the index shows; skip the write. The stored row
        // keeps its older version, which is still monotonic: any later change has a higher one.
        // Only with no write in flight here: an older one landing after the skip would be stale
        // content with a version above the stored row's, and win.
        if (!force && !inflight && written && JSON.stringify(row) === JSON.stringify(written)) {
          synced = Math.max(synced, version);
          return;
        }
        inflight++;
        try {
          // ponytail: awaited inside the call, so D1 latency lands on the caller; move to waitUntil if it shows.
          await index.upsert({ def: def.id, id, ...row, updatedAt: d.now(), version });
        } catch (e) {
          // It may have committed with the response lost: what's stored is unknown, so the next sync writes.
          written = null;
          throw e;
        } finally {
          inflight--;
        }
        if (version >= synced) [synced, written] = [version, row];
      }
      return {
        methods: { "index.sync": async () => (await sync(true), null) },
        after: () => sync(false),
      };
    },
  };
}
