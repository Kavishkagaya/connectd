import { BEARER, type Credential, inject, MissingField } from "@connectd/connections";
import type { Json, Limit, Limiter } from "@connectd/kernel";
import { type AnyDefinition, Fail, type Hosted, instanceOf } from "./host.ts";
import { ERROR_HEADER, reply } from "./http.ts";
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

/** The definition's limiters, declared once per instance: the connection's own, and the app-wide one in `app:<def>`. */
function limiters(h: Hosted): Limiter[] {
  const r = h.def.rate;
  if (!r) return [];
  const own = h.k.limiter("proxy", r.connection ?? OBSERVE_ONLY);
  // ponytail: one app per deployment (see Settings.config), so the app scope is per definition; key it by app when multi-app.
  return r.app ? [own, h.k.limiter.at(`app:${h.def.id}`, "proxy", r.app)] : [own];
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
// Hop-by-hop headers too: they describe this hop, and fetch refuses some (transfer-encoding on Node).
const STRIP = ["authorization", "host", "content-length", "connection", "keep-alive", "transfer-encoding", "te", "upgrade"];

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
              { status: 429, headers: { "retry-after": String(Math.ceil(ready.retryAfterMs / 1000)), [ERROR_HEADER]: "rate_limited" } },
            );
          }

          const headers = new Headers(req.headers);
          for (const h of STRIP) headers.delete(h);
          try {
            inject(d.proxy.inject ?? BEARER, url, headers, ready.credential);
          } catch (e) {
            if (e instanceof MissingField) throw new Fail("bad_credential", 500, e.message);
            throw e;
          }

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
          // Only the runtime's own errors carry it; a provider's response never does.
          out.delete(ERROR_HEADER);
          return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
        },
      },
    },

    connection: (h) => {
      const all = limiters(h);
      return {
        methods: {
          /** Token (refreshed if due) + permits in one round trip. Token first, so a dead connection uses no permit. */
          "proxy.prepare": async () => {
            const credential = await h.bound.token();
            const v = await h.k.acquire(all);
            return (v.ok ? { credential } : { retryAfterMs: v.retryAfterMs }) as unknown as Json;
          },
          /** Feed response headers to the definition's `rate.observe` (connection scope), or refund a request that never left. */
          "proxy.settle": async (a) => {
            const s = (a ?? {}) as Settle;
            if (s.refund) await h.k.refund(all);
            const own = all[0];
            const see = h.def.rate?.observe;
            if (own && see && s.status) {
              // ponytail: provider-wide signals (a Retry-After on a per-project quota) only tighten this connection's scope.
              const seen = see(new Response(null, { status: s.status, headers: s.headers ?? {} }), h.k.now());
              if (Object.keys(seen).length) await own.observe(seen);
            }
            return null;
          },
        },
      };
    },
  };
}
