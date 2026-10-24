import { base64url, type Json, routeTicket } from "@openconnect/kernel";
import { type Index, listing } from "./directory.ts";
import { type AnyDefinition, COOKIES, Fail, type Fault, fault, instanceOf, type Reply, type Settings, type Target } from "./host.ts";
import { complete } from "./session.ts";

/** How the Worker reaches an instance: a DO stub's `onCall` on Cloudflare, `memory().call` in tests. */
export type Call = (instance: string, method: string, args: Json) => Promise<Json>;

export type Api = {
  /** Call a connection method; always a Reply (connection methods never throw across the boundary). */
  call(instance: string, method: string, args: Json): Promise<Reply>;
  settings: Settings;
  /** The Worker's clock (webhook timestamp checks); a fake in tests. */
  now(): number;
  definitions: Record<string, AnyDefinition>;
  /** The connection index, if an extension provides one (`directory`). */
  index?: Index;
  /** Method names refused over HTTP (`Extension.internal`). */
  internal: Set<string>;
};

/** Handles `/<name>/...` (the routes table is keyed by first path segment). `path` is what follows it, decoded. */
export type Route = { public?: boolean; fetch(req: Request, api: Api, path: string[]): Promise<Response> };

/**
 * Errors the runtime itself answers carry `openconnect-error: <code>`, so a client can tell them from
 * a provider's response on the proxy (the proxy strips the header from upstream responses).
 */
export const ERROR_HEADER = "openconnect-error";

export const reply = (r: Reply) =>
  "ok" in r ? Response.json(r.ok) : Response.json({ error: r.error }, { status: r.error.status, headers: { [ERROR_HEADER]: r.error.code } });

async function args(req: Request): Promise<Json> {
  const text = await req.text();
  try {
    return text ? (JSON.parse(text) as Json) : null;
  } catch {
    throw new Fail("bad_request", 400, "body is not JSON");
  }
}

export const routes: Record<string, Route> = {
  /**
   * GET  /connections?def=&state=&q=&external=key:value&cursor=&limit=   list from the index
   * GET  /connections/:def/:id          status + metadata
   * POST /connections/:def/:id/:method  connect | token | revoke | any extension method; JSON body = args
   * POST /connections/:def/:id/actions/:action   an action (#54): the method `actions.<action>`
   */
  connections: {
    async fetch(req, api, [def, id, m, ...more]) {
      const [method, rest] = m === "actions" && more.length === 1 ? [`actions.${more[0]}`, []] : [m, more];
      if (!def && api.index) return listing(req, api.index);
      if (!def || !id || rest.length) throw new Fail("not_found", 404, "no such route");
      if (!Object.hasOwn(api.definitions, def)) throw new Fail("not_found", 404, `unknown definition ${def}`);
      const instance = instanceOf(def, id);
      if (!method) {
        if (req.method !== "GET") throw new Fail("method_not_allowed", 405, "GET only");
        return reply(await api.call(instance, "status", null));
      }
      if (req.method !== "POST") throw new Fail("method_not_allowed", 405, "POST only");
      // Kernel methods (RATE) are instance-to-instance only; internal extension methods are for their own routes.
      if (method.startsWith("kernel.") || api.internal.has(method)) throw new Fail("not_found", 404, "no such route");
      return reply(await api.call(instance, method, await args(req)));
    },
  },

  /**
   * The provider redirects the user here. `state` names the instance (signed), so no lookup.
   * Answers JSON, unless a frontend session started it (#29): then a redirect to its return URL or
   * a page that posts the result to the opener.
   */
  callback: {
    public: true,
    async fetch(req, api) {
      const q = Object.fromEntries(new URL(req.url).searchParams);
      // A login ticket (the lifecycle's handshake): signed, names its instance.
      const r = await routeTicket(q.state ?? "", api.settings.stateKey);
      if (!r || r.name !== "login") throw new Fail("bad_request", 400, "unknown or forged state");
      // The Cookie header overwrites any query parameter of that name: the binding comes from the browser only.
      const res = await api.call(r.instance, "callback", { ...q, [COOKIES]: req.headers.get("cookie") ?? "" });
      if ("ok" in res && res.ok && typeof res.ok === "object" && "target" in res.ok) {
        const s = res.ok as { target: Target; completion?: string; error?: Fault };
        return complete(api.settings, s.target, s.error ? { status: "error", code: s.error.code, message: s.error.message } : { status: "authorized", completion: s.completion ?? "" });
      }
      return reply(res);
    },
  },
};

const digest = async (s: string) => base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));

/**
 * The request carries `Authorization: Bearer <key>`. Compares digests, not the strings, so the
 * comparison leaks nothing about the key. For public routes with an API-key part (the dashboard's `/api`).
 */
export async function authorized(req: Request, key: string) {
  return key !== "" && (await digest(req.headers.get("authorization") ?? "")) === (await digest(`Bearer ${key}`));
}

/** The Worker's fetch: route by first path segment, check the API key unless the route is public. */
export function http(o: {
  routes: Record<string, Route>;
  definitions: Record<string, AnyDefinition>;
  settings: () => Promise<Settings>;
  index?: Index;
  internal?: Set<string>;
  now?: () => number;
}) {
  return async (req: Request, call: Call): Promise<Response> => {
    try {
      const settings = await o.settings();
      const [name = "", ...path] = new URL(req.url).pathname.split("/").filter(Boolean).map(decodeURIComponent);
      const route = Object.hasOwn(o.routes, name) ? o.routes[name] : undefined;
      if (!route) throw new Fail("not_found", 404, "no such route");
      if (!route.public && !(await authorized(req, settings.apiKey))) throw new Fail("unauthorized", 401, "missing or wrong API key");
      const api: Api = { settings, now: o.now ?? Date.now, definitions: o.definitions, call: async (i, m, a) => (await call(i, m, a)) as Reply, internal: o.internal ?? new Set(), ...(o.index ? { index: o.index } : {}) };
      return await route.fetch(req, api, path);
    } catch (e) {
      return reply({ error: fault(e, "worker") });
    }
  };
}
