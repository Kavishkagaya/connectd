import type { ActionSpec, StandardSchemaV1 } from "@connectd/connections";
import type { Json } from "@connectd/kernel";
import { type Api, authorized, type EventsStatus, type Extension, Fail, instanceOf, type Reply, type Route } from "@connectd/runtime";
import { css, js, version } from "./assets.ts";

/**
 * The self-host dashboard (#32): a small UI at `/dashboard` served by the runtime's own Worker, so a
 * deployment has it with nothing else to deploy. The page and its script are public (nothing secret
 * in them); everything it shows comes from API-key routes, and the browser holds the API key:
 *
 *   GET /dashboard                               the page (strict CSP: same-origin script and style only)
 *   GET /dashboard/app.js, /dashboard/app.css    the UI, built into assets.ts (`bun run build`)
 *   GET /dashboard/api/overview                  deployment + definitions: configured, URLs to register  (API key)
 *   GET /dashboard/api/connections/:def/:id      one connection: status, external ids, events, webhooks, actions, subscriptions   (API key)
 *   GET /dashboard/api/failures?def=             recent failed scheduled actions across connections   (API key)
 *
 * Lists and actions use the runtime's own routes (`GET /connections?…`, `POST /connections/:def/:id/revoke`,
 * `index.sync`, `events.flush`, `events.redeliver`, `connect`, `actions/<name>`, `webhooks.unsubscribe`). Nothing it serves holds a secret: no
 * credential, token, config value, key or webhook secret.
 */

/** One action (#54) as the dashboard shows it: its trigger, and its input's JSON Schema when the validator gives one. */
export type ActionInfo = {
  id: string;
  /** `.every(ms)`. */
  every: number | null;
  /** `.on(state)`. */
  on: string | null;
  /** Takes input (an `input` schema). */
  input: boolean;
  /** The input as JSON Schema (Standard JSON Schema: zod 4, valibot, arktype); null when the validator doesn't export one. */
  schema: Json | null;
};

export type DefinitionInfo = {
  id: string;
  /** `redirect`: authorized at the provider. `form`: API-key fields. */
  flow: "redirect" | "form";
  fields: string[];
  /** Has an entry in the connector config; without one it answers `not_configured`. */
  configured: boolean;
  /** Config entries that are empty (undefined, null or ""): names only, never values. */
  missing: string[];
  /** The proxy's base URL. */
  proxy: string | null;
  /** Ingress URLs to give the provider: app-level and per connection (`:id`), and whether it registers them itself. */
  webhooks: { app: string; connection: string; registers: boolean } | null;
  /** Takes explicit webhook subscriptions (a `subscription` schema). */
  subscribes: boolean;
  actions: ActionInfo[];
};

export type Overview = {
  /** The redirect URI to register with every OAuth provider. */
  callbackUrl: string;
  /** A connection index is installed (`directory`): list and search work. */
  index: boolean;
  /** Where events go; the query string is hidden (it may carry a token). */
  events: { url: string } | null;
  sessions: { origins: string[] } | null;
  webhooks: { url: string } | null;
  definitions: DefinitionInfo[];
};

/** One connection. Each part is the runtime's Reply as is: an extension that isn't installed answers an error. */
export type Detail = {
  definition: string;
  id: string;
  /** `status`: state, reason, metadata. `not_found`: no connection yet. */
  status: Reply;
  /** From the definition's `external(metadata)`; null when there is none or it throws. */
  external: Record<string, string> | null;
  events: Reply;
  webhooks: Reply;
  /** `actions.status` (trigger and next run of each); null when the definition has no actions. */
  actions: Reply | null;
  /** `webhooks.list`; null when the definition takes no subscriptions. */
  subscriptions: Reply | null;
};

/** One failed scheduled run, from a connection's kept events. */
export type Failure = { def: string; id: string; action: string; trigger: string; error: string; attempt: number; at: number };
export type Failures = {
  failures: Failure[];
  /** Connections looked at; `more`: the index has more than were scanned. */
  scanned: number;
  more: boolean;
};

/** Origin and path; a query string (a token in the URL) is replaced by `?…`. */
function bare(url: string) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}${u.search ? "?…" : ""}`;
  } catch {
    return "(not a URL)";
  }
}

const empty = (v: unknown) => v === undefined || v === null || v === "";

type JsonSchemaSource = { "~standard": { jsonSchema?: { input?(o: { target: string }): unknown } } };
/** The input's JSON Schema through Standard JSON Schema (`~standard.jsonSchema`), or null. */
function jsonSchema(s: StandardSchemaV1 | undefined): Json | null {
  try {
    const out = (s as JsonSchemaSource | undefined)?.["~standard"].jsonSchema?.input?.({ target: "draft-2020-12" });
    return out && typeof out === "object" ? (JSON.parse(JSON.stringify(out)) as Json) : null;
  } catch {
    return null;
  }
}
const actionInfo = (a: ActionSpec): ActionInfo => ({ id: a.id, every: a.every ?? null, on: a.on ?? null, input: !!a.input, schema: jsonSchema(a.input) });

function overview(api: Api): Overview {
  const s = api.settings;
  const hooks = (s.webhooks?.url ?? `${new URL(s.redirectUri).origin}/webhooks`).replace(/\/+$/, "");
  return {
    callbackUrl: s.redirectUri,
    index: !!api.index,
    events: s.events ? { url: bare(s.events.url) } : null,
    sessions: s.sessions ? { origins: s.sessions.origins } : null,
    webhooks: s.webhooks ? { url: hooks } : null,
    definitions: Object.values(api.definitions).map((d) => {
      const c = s.config[d.id];
      return {
        id: d.id,
        flow: d.auth.callback ? "redirect" : "form",
        fields: d.auth.fields ?? [],
        configured: Object.hasOwn(s.config, d.id),
        missing: c && typeof c === "object" ? Object.entries(c).flatMap(([k, v]) => (empty(v) ? [k] : [])) : [],
        proxy: d.proxy?.baseUrl ?? null,
        webhooks: d.webhooks
          ? { app: `${hooks}/${encodeURIComponent(d.id)}`, connection: `${hooks}/${encodeURIComponent(d.id)}/:id`, registers: !!d.webhooks.register && !d.webhooks.subscription && !!s.webhooks }
          : null,
        subscribes: !!d.webhooks?.subscription,
        actions: (api.actions[d.id] ?? []).map(actionInfo),
      };
    }),
  };
}

async function detail(api: Api, def: string, id: string): Promise<Detail> {
  const d = Object.hasOwn(api.definitions, def) ? api.definitions[def] : undefined;
  if (!d) throw new Fail("not_found", 404, `unknown definition ${def}`);
  const i = instanceOf(def, id);
  const [status, events, webhooks, actions, subscriptions] = await Promise.all([
    api.call(i, "status", null),
    api.call(i, "events.status", null),
    api.call(i, "webhooks.status", null),
    api.actions[def]?.length ? api.call(i, "actions.status", null) : null,
    d.webhooks?.subscription ? api.call(i, "webhooks.list", null) : null,
  ]);
  let external: Record<string, string> | null = null;
  const meta = "ok" in status ? (status.ok as { metadata?: unknown } | null)?.metadata : null;
  if (meta != null && d.external)
    try {
      external = d.external(meta);
    } catch {}
  return { definition: def, id, status, external, events, webhooks, actions, subscriptions };
}

/** Connections scanned per failures request. */
const SCAN = 100;
/**
 * Failed scheduled runs across connections: the first SCAN connections in the index (for one
 * definition with `def`), each one's kept events. ponytail: a scan, bounded and in index order; an
 * app-wide failure log (an `app:<def>` instance the actions extension reports to) when deployments outgrow it.
 */
async function failures(api: Api, def: string | null): Promise<Failures> {
  if (!api.index) throw new Fail("not_found", 404, "no connection index (directory): the failures view needs it");
  if (def !== null && !Object.hasOwn(api.definitions, def)) throw new Fail("not_found", 404, `unknown definition ${def}`);
  const page = await api.index.list({ ...(def ? { def } : {}), limit: SCAN });
  const rows = page.connections.filter((r) => api.actions[r.def]?.length);
  const out: Failure[] = [];
  await Promise.all(
    rows.map(async (r) => {
      const ev = await api.call(instanceOf(r.def, r.id), "events.status", null);
      if (!("ok" in ev)) return;
      const s = ev.ok as unknown as EventsStatus;
      for (const e of [...s.queued, ...s.recent])
        if (e.type.endsWith(".failed") && !e.copy) {
          const x = e.data as { action?: string; trigger?: string; error?: string; attempt?: number };
          out.push({ def: r.def, id: r.id, action: x.action ?? e.type.slice(0, -".failed".length), trigger: x.trigger ?? "", error: x.error ?? "", attempt: x.attempt ?? 0, at: e.at });
        }
    }),
  );
  out.sort((a, b) => b.at - a.at);
  return { failures: out, scanned: page.connections.length, more: page.cursor !== null };
}

/** Same-origin script and style only, no inline anything, no framing, no form posts, no referrer. */
export const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const SAFE = { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };

const page = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>connectd</title>
<link rel="stylesheet" href="/dashboard/app.css?v=${version}">
<main id="app"><noscript>The dashboard needs JavaScript.</noscript></main>
<script type="module" src="/dashboard/app.js?v=${version}"></script>
</html>
`;

function asset(req: Request, body: string, type: string) {
  // Versioned URLs (the page links `?v=<hash of the sources>`) never change; anything else revalidates.
  const cache = new URL(req.url).searchParams.get("v") === version ? "public, max-age=31536000, immutable" : "no-cache";
  return new Response(req.method === "HEAD" ? null : body, { headers: { ...SAFE, "content-type": type, "cache-control": cache } });
}

const route: Route = {
  public: true,
  async fetch(req, api, [part, ...rest]) {
    if (part === "api") {
      if (!(await authorized(req, api.settings.apiKey))) throw new Fail("unauthorized", 401, "missing or wrong API key");
      if (req.method !== "GET") throw new Fail("method_not_allowed", 405, "GET only");
      const [what, def, id, ...more] = rest;
      if (what === "overview" && !def) return Response.json(overview(api), { headers: { "cache-control": "no-store" } });
      if (what === "connections" && def && id && !more.length) return Response.json(await detail(api, def, id), { headers: { "cache-control": "no-store" } });
      if (what === "failures" && !def) return Response.json(await failures(api, new URL(req.url).searchParams.get("def") || null), { headers: { "cache-control": "no-store" } });
      throw new Fail("not_found", 404, "no such route");
    }
    if (req.method !== "GET" && req.method !== "HEAD") throw new Fail("method_not_allowed", 405, "GET only");
    if (rest.length) throw new Fail("not_found", 404, "no such route");
    if (part === "app.js") return asset(req, js, "text/javascript; charset=utf-8");
    if (part === "app.css") return asset(req, css, "text/css; charset=utf-8");
    if (part !== undefined) throw new Fail("not_found", 404, "no such route");
    return new Response(req.method === "HEAD" ? null : page, {
      headers: { ...SAFE, "content-type": "text/html; charset=utf-8", "content-security-policy": CSP, "cache-control": "no-store", "cross-origin-opener-policy": "same-origin" },
    });
  },
};

/** `extensions: [dashboard()]`: the UI at `/dashboard`. Sign in with the deployment's API key. */
export const dashboard = (): Extension => ({ routes: { dashboard: route } });
