import type { Json, KeyKind } from "@kavishkagaya/connectd-kernel";
import { adminRequest, badName, createKey, keyInfo, revokeKey, rollKey, session } from "./access.ts";
import { Fail } from "./host.ts";
import type { Api, Route } from "./http.ts";

/**
 * `/admin` (#86): the deployment's keys, managed by the CLI (`Authorization: Admin <token>`, signed
 * with the admin key it derives from the root key) and the dashboard (its session cookie). Both talk
 * to the same deployment, so a key made in one shows in the other.
 *
 *   GET  /admin/info                    deployment, key and account counts
 *   GET  /admin/keys                    every key (never a value)
 *   POST /admin/keys                    { name, kind?: "api" | "events" }  → { key, info }: key shown once
 *   POST /admin/keys/:id/roll           { graceMs? }                       → { key, info }: the old secret works for graceMs
 *   POST /admin/keys/:id/revoke                                            → info
 */

/** The longest grace period a roll takes. */
export const MAX_GRACE_MS = 7 * 86_400_000;

async function body(req: Request): Promise<Record<string, Json>> {
  const t = await req.text();
  if (!t) return {};
  try {
    const v = JSON.parse(t) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, Json>;
  } catch {}
  throw new Fail("bad_request", 400, "body is not a JSON object");
}

/** May this request manage the deployment: the CLI, or a dashboard session. */
export const admin = async (req: Request, api: Pick<Api, "platform" | "settings">) =>
  (await adminRequest(api.platform, api.settings.admin, req)) || !!(await session(api.platform, api.settings.admin, req));

export const adminRoute: Route = {
  public: true, // its own check: admin tokens and sessions, never an API key
  async fetch(req, api, [what, id, op, ...more]) {
    if (!(await admin(req, api))) throw new Fail("unauthorized", 401, "admin routes take a CLI request (connectd keys) or a dashboard session");
    const p = api.platform;
    const json = (v: unknown, status = 200) => Response.json(v, { status, headers: { "cache-control": "no-store" } });
    if (what === "info" && !id && req.method === "GET") {
      const keys = await p.db.keys.list();
      const live = (k: KeyKind) => keys.filter((r) => r.kind === k && r.revokedAt === null).length;
      return json({ version: p.version, url: new URL(api.settings.redirectUri).origin, keys: { api: live("api"), events: live("events") }, accounts: (await p.db.accounts.list()).length, events: !!api.settings.events });
    }
    if (what !== "keys" || more.length) throw new Fail("not_found", 404, "no such route");
    if (!id) {
      if (req.method === "GET") return json((await p.db.keys.list()).map((r) => keyInfo(r, p.now())));
      if (req.method !== "POST") throw new Fail("method_not_allowed", 405, "GET or POST");
      const b = await body(req);
      const bad = badName(b.name);
      if (bad) throw new Fail("bad_request", 400, `name: ${bad}`);
      const kind = b.kind ?? "api";
      if (kind !== "api" && kind !== "events") throw new Fail("bad_request", 400, 'kind: "api" or "events"');
      return json(await createKey(p, api.settings.keys, kind, b.name as string), 201);
    }
    if (req.method !== "POST" || (op !== "roll" && op !== "revoke")) throw new Fail("not_found", 404, "no such route");
    if (op === "revoke") {
      const r = await revokeKey(p, id);
      if (!r) throw new Fail("not_found", 404, `no live key ${id}`);
      return json(r);
    }
    const b = await body(req);
    const grace = b.graceMs ?? 0;
    if (typeof grace !== "number" || !Number.isInteger(grace) || grace < 0 || grace > MAX_GRACE_MS) throw new Fail("bad_request", 400, `graceMs: an integer from 0 to ${MAX_GRACE_MS} (7 days)`);
    const r = await rollKey(p, api.settings.keys, id, grace);
    if (!r) throw new Fail("not_found", 404, `no live key ${id}`);
    return json(r);
  },
};
