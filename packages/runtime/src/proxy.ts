import type { Inject } from "@openconnect/connections";
import { acquire, type Credential, type Json, type Limit, observe, refund, type Scope } from "@openconnect/kernel";
import { type AnyDefinition, Fail, type Hosted, instanceOf } from "./host.ts";
import { reply } from "./http.ts";
import type { Extension } from "./runtime.ts";

/**
 * The proxy: `ANY /proxy/:def/:id/<path>?<query>` → `<definition.proxy.baseUrl>/<path>?<query>` with
 * the connection's credential on it. Two DO round trips at most, and no body ever enters the DO:
 *   1. `proxy.prepare` in the connection instance: token (refreshed if due) + rate permits.
 *   2. The Worker fetches upstream itself, streaming both bodies straight through.
 *   3. `proxy.settle` sends the response status + headers back for the definition's `rate.observe`
 *      (or refunds the permits if the request never left).
 */

export type Prepared = { credential: Credential } | { retryAfterMs: number };
export type Settle = { status?: number; headers?: Record<string, string>; refund?: boolean };

/** Scope used when a definition only observes (Google): huge, so it only ever holds what the provider says. */
const OBSERVE_ONLY: Limit = { count: 1_000_000, periodMs: 1000 };

function scopes(h: Hosted): Scope[] {
  const r = h.def.rate;
  if (!r) return [];
  const own: Scope = { instance: h.instance, key: "proxy", limit: r.connection ?? OBSERVE_ONLY };
  // ponytail: one app per deployment (see Settings.config), so the app scope is per definition; key it by app when multi-app.
  return r.app ? [own, { instance: `app:${h.def.id}`, key: "proxy", limit: r.app }] : [own];
}

function value(cred: Credential, field?: string): string {
  if (cred.kind === "oauth2") return cred.accessToken;
  const v = field ? cred.fields[field] : Object.values(cred.fields)[0];
  if (v === undefined) throw new Fail("bad_credential", 500, `credential has no field ${field ?? "(any)"}`);
  return v;
}

const BEARER: Inject = { header: "authorization", prefix: "Bearer " };

function inject(i: Inject, url: URL, headers: Headers, cred: Credential) {
  if (typeof i === "function") i(url, headers, cred);
  else if ("query" in i) url.searchParams.set(i.query, value(cred, i.field));
  else headers.set(i.header, (i.prefix ?? "") + value(cred, i.field));
}

/**
 * The upstream URL: the raw (still encoded) rest after /proxy/:def/:id, trailing slash and query
 * kept. It can't climb out of the base path: the incoming URL is already normalized (`..`,
 * `%2e%2e`), and `%2F` stays encoded.
 */
function target(def: AnyDefinition, req: Request): URL {
  const u = new URL(req.url);
  return new URL(`${(def.proxy?.baseUrl ?? "").replace(/\/+$/, "")}/${u.pathname.replace(/^\/[^/]*\/[^/]*\/[^/]*\/?/, "")}${u.search}`);
}

// Our API key and the client's host must not reach the provider; the injected credential replaces them.
const STRIP = ["authorization", "host", "content-length"];

export function proxy(o: { timeoutMs?: number } = {}): Extension {
  const timeoutMs = o.timeoutMs ?? 30_000;
  return {
    internal: ["proxy.prepare", "proxy.settle"],
    routes: {
      proxy: {
        async fetch(req, api, [def, id]) {
          if (!def || !id) throw new Fail("not_found", 404, "no such route");
          const d = Object.hasOwn(api.definitions, def) ? api.definitions[def] : undefined;
          if (!d?.proxy) throw new Fail("not_found", 404, `no proxy for ${def}`);
          const url = target(d, req);
          const instance = instanceOf(def, id);

          // Bookkeeping only: a failed settle must never cost the caller a response (the POST may have gone through).
          const settle = (a: Settle) =>
            api.call(instance, "proxy.settle", a as unknown as Json).then(
              (r) => "error" in r && console.error("proxy settle", instance, r.error),
              (e) => console.error("proxy settle", instance, e),
            );

          const p = await api.call(instance, "proxy.prepare", null);
          if ("error" in p) return reply(p);
          const ready = p.ok as unknown as Prepared;
          if ("retryAfterMs" in ready) {
            return Response.json(
              { error: { code: "rate_limited", status: 429, message: "rate limited", retryAfterMs: ready.retryAfterMs } },
              { status: 429, headers: { "retry-after": String(Math.ceil(ready.retryAfterMs / 1000)) } },
            );
          }

          const headers = new Headers(req.headers);
          for (const h of STRIP) headers.delete(h);
          inject(d.proxy.inject ?? BEARER, url, headers, ready.credential);

          // The timeout covers the wait for response headers only; a long download keeps streaming.
          const ac = new AbortController();
          const timer = setTimeout(() => ac.abort(), timeoutMs);
          let res: Response;
          try {
            const f = api.settings.fetch ?? fetch;
            // duplex: required to stream a request body (not in the DOM RequestInit types yet).
            res = await f(url, { method: req.method, headers, body: req.body, redirect: "manual", signal: ac.signal, ...({ duplex: "half" } as {}) });
          } catch (e) {
            if (ac.signal.aborted) throw new Fail("upstream_timeout", 504, `no response from ${url.origin} in ${timeoutMs}ms`);
            // ponytail: a network error may still have reached the provider; we refund anyway (it rarely did).
            if (d.rate) await settle({ refund: true });
            throw new Fail("upstream_error", 502, e instanceof Error ? e.message : String(e));
          } finally {
            clearTimeout(timer);
          }

          // ponytail: awaits one more DO call before answering; move to ctx.waitUntil once routes get the execution context.
          if (d.rate?.observe) await settle({ status: res.status, headers: Object.fromEntries(res.headers) });
          // fetch already decoded the body, so its encoding and length no longer describe what we send.
          const out = new Headers(res.headers);
          out.delete("content-encoding");
          out.delete("content-length");
          return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
        },
      },
    },

    connection: (h) => ({
      methods: {
        /** Token (refreshed if due) + permits in one round trip. Token first, so a dead connection uses no permit. */
        "proxy.prepare": async () => {
          const credential = await h.bound.token();
          const v = await acquire(h.d, h.instance, scopes(h));
          return (v.ok ? { credential } : { retryAfterMs: v.retryAfterMs }) as unknown as Json;
        },
        /** Feed response headers to `rate.observe` (connection scope), or refund a request that never left. */
        "proxy.settle": async (a) => {
          const s = (a ?? {}) as Settle;
          const all = scopes(h);
          if (s.refund) await refund(h.d, h.instance, all);
          const own = all[0];
          const see = h.def.rate?.observe;
          if (own && see && s.status) {
            // ponytail: provider-wide signals (a Retry-After on a per-project quota) only tighten this connection's scope.
            const seen = see(new Response(null, { status: s.status, headers: s.headers ?? {} }), h.d.now());
            if (Object.keys(seen).length) await observe(h.d, h.instance, own, seen);
          }
          return null;
        },
      },
    }),
  };
}
