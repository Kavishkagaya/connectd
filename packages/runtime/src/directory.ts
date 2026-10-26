import { BadCursor, type ConnectionPage, type ConnectionQuery, type ConnectionRow, type Json, type Management, MAX_PAGE, PAGE } from "@kavishkagaya/connectd-kernel";
import { Fail, message } from "./host.ts";
import type { Extension } from "./runtime.ts";

/**
 * The connection index (#26): a copy of every connection's state and external ids, for listing,
 * search and lookup by external id (webhooks route by it, #25), kept in the platform's management
 * db (`platform.db.connections`: D1 on Cloudflare, maps in memory). The atom is the source of truth;
 * each one upserts its own row after every method and timer, versioned so a stale write never wins.
 * Nothing secret is copied.
 *
 *   runtime({ definitions, settings, extensions: [directory()] });
 */

export type Row = ConnectionRow;
export type Query = ConnectionQuery;
export type Page = ConnectionPage;
export type Index = Management["connections"];

/** `GET /connections?def=&state=&q=&external=key:value&cursor=&limit=`, served by the built-in `connections` route. */
export async function listing(req: Request, index: Index): Promise<Response> {
  if (req.method !== "GET") throw new Fail("method_not_allowed", 405, "GET only");
  const p = new URL(req.url).searchParams;
  const opt = (n: string) => p.get(n) || undefined;
  const limit = Number(p.get("limit") ?? PAGE);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) throw new Fail("bad_request", 400, `limit is 1-${MAX_PAGE}`);
  const ext = opt("external");
  const colon = ext?.indexOf(":") ?? -1;
  if (ext && colon < 1) throw new Fail("bad_request", 400, "external is key:value");
  const q: Query = { limit };
  for (const k of ["def", "state", "q", "cursor"] as const) {
    const v = opt(k);
    if (v) q[k] = v;
  }
  if (ext) q.external = { key: ext.slice(0, colon), value: ext.slice(colon + 1) };
  try {
    return Response.json(await index.list(q));
  } catch (e) {
    if (e instanceof BadCursor) throw new Fail("bad_request", 400, "bad cursor");
    throw e;
  }
}

/**
 * The index as an extension: each connection keeps its row current from `after`, `index.sync`
 * re-copies it on demand, and the runtime hands the index to routes as `api.index`.
 */
export function directory(): Extension {
  return {
    index: true,
    connection: ({ k, platform, def, id, bound }) => {
      const index = platform.db.connections;
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
          platform.log("error", "directory.external_hook.failed", { def: def.id, id, error: message(e) });
          return written?.external ?? {};
        }
      }

      async function sync(force: boolean) {
        // The metadata cell (bind's). It's written after the record, so reading it first means a
        // read torn by a concurrent re-auth gets a lower version than the read after it.
        const meta = await bound.meta.read();
        // Both versions come from one counter per instance, so the max orders the pair.
        // Most calls (token, status, proxied requests) change nothing: stop before decrypting.
        if (!force && Math.max((await bound.conn.version()) ?? 0, meta?.v ?? 0) === synced) return;
        const s = await bound.conn.read();
        if (!s) return; // nothing was ever created (a failed first connect)
        const version = Math.max(s.v, meta?.v ?? 0);
        const row = { state: s.state, reason: s.reason ?? null, external: externalOf(meta?.value.m ?? null) };
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
          // ponytail: awaited inside the call, so D1 latency lands on the caller; move to platform.defer if it shows.
          await index.upsert({ def: def.id, id, ...row, updatedAt: k.now(), version });
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
