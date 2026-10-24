import { type Api, authorized, type Extension, Fail, instanceOf, type Reply, type Route } from "@connectd/runtime";
import { css, js, version } from "./assets.ts";

/**
 * The self-host dashboard (#32): a small UI at `/dashboard` served by the runtime's own Worker, so a
 * deployment has it with nothing else to deploy. The page and its script are public (nothing secret
 * in them); everything it shows comes from API-key routes, and the browser holds the API key:
 *
 *   GET /dashboard                               the page (strict CSP: same-origin script and style only)
 *   GET /dashboard/app.js, /dashboard/app.css    the UI, built into assets.ts (`bun run build`)
 *   GET /dashboard/api/overview                  deployment + definitions: configured, URLs to register  (API key)
 *   GET /dashboard/api/connections/:def/:id      one connection: status, external ids, events, webhooks   (API key)
 *
 * Lists and actions use the runtime's own routes (`GET /connections?…`, `POST /connections/:def/:id/revoke`,
 * `index.sync`, `events.flush`, `events.redeliver`, `connect`). Nothing it serves holds a secret: no
 * credential, token, config value, key or webhook secret.
 */

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
          ? { app: `${hooks}/${encodeURIComponent(d.id)}`, connection: `${hooks}/${encodeURIComponent(d.id)}/:id`, registers: !!d.webhooks.register && !!s.webhooks }
          : null,
      };
    }),
  };
}

async function detail(api: Api, def: string, id: string): Promise<Detail> {
  const d = Object.hasOwn(api.definitions, def) ? api.definitions[def] : undefined;
  if (!d) throw new Fail("not_found", 404, `unknown definition ${def}`);
  const i = instanceOf(def, id);
  const [status, events, webhooks] = await Promise.all([api.call(i, "status", null), api.call(i, "events.status", null), api.call(i, "webhooks.status", null)]);
  let external: Record<string, string> | null = null;
  const meta = "ok" in status ? (status.ok as { metadata?: unknown } | null)?.metadata : null;
  if (meta != null && d.external)
    try {
      external = d.external(meta);
    } catch {}
  return { definition: def, id, status, external, events, webhooks };
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
