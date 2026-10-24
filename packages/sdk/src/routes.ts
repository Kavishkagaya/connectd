import { ConnectdError } from "./client.ts";
import type { SessionArgs } from "@connectd/runtime";

/**
 * The app's one route (#54, app side), mounted anywhere (`app/api/connectd/[...path]/route.ts`):
 *
 *   export const { GET, POST } = oc.routes;
 *
 *   GET  <base>/connect/:def?account=&return=   start connecting the signed-in user (`user(req)`): to the provider
 *   GET  <base>/return                          where the provider flow comes back: a page that confirms it, then goes to `return`
 *   POST <base>/return                          that page's confirmation, checked against `user(req)`
 *   POST <base>/events                          signed events from the runtime, to the folders' `listen()` handlers
 *
 * The connection id is the user's id, or `<user>:<account>` with `?account=` (several accounts of
 * one provider; so user ids can't contain `:`). Connect links only work from the app's own pages
 * (`Sec-Fetch-Site`). The page the user lands on gets `?connectd=connected&definition=&id=` (or
 * `error&code=`): a hint for the UI, not proof; read `status()` for the truth. The flow is a redirect-mode session (#29): bound to this browser by the runtime's
 * cookie, and confirmed here only for the user it was started for. The app's origin must be in the
 * config's `sessions.origins`.
 */

/** The signed-in user's id (no `:`), or null. */
export type User = (req: Request) => string | number | null | undefined | Promise<string | number | null | undefined>;

type Deps = {
  /** The runtime's base URL and fetch, read on each request (env may be set after import). */
  base: () => string;
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  // Structural, not the client's types: those include `routes` itself.
  connection: (def: string, id: string) => { session(a: SessionArgs): Promise<{ token: string }>; link(o: { next?: string }): Promise<{ url: string }> };
  events: () => { handle(req: Request): Promise<Response> };
  user?: User;
  /** The app's public origin, if `req.url` doesn't show it (behind a proxy). */
  origin?: string;
};

const ACCOUNT = /^[A-Za-z0-9_-]{1,64}$/;

const fail = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status });

/**
 * A path on `origin` (`/settings?tab=1`), resolved the way the browser will (it drops tabs and
 * newlines, so `/<tab>/evil.test` is `//evil.test`): anything off this origin is `/`.
 */
function local(p: string | null, origin: string): string {
  if (!p || !p.startsWith("/")) return "/";
  try {
    const u = new URL(p, origin);
    return u.origin === origin ? u.pathname + u.search : "/";
  } catch {
    return "/";
  }
}

/** The page on `<base>/return`: reads the outcome from the fragment, confirms it, then goes on. */
function returnPage(to: string): Response {
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const back = JSON.stringify(to).replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const body = `<!doctype html><meta charset="utf-8"><title>Connecting…</title><p>Connecting…</p>
<script nonce="${nonce}">(async () => {
  const f = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, "", location.pathname + location.search);
  const to = new URL(${back}, location.origin);
  let status = f.get("connectd"), code = f.get("code");
  if (status === "authorized") {
    const res = await fetch(location.pathname, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ definition: f.get("definition"), id: f.get("id"), completion: f.get("completion") }) }).catch(() => null);
    const r = res ? await res.json().catch(() => null) : null;
    if (res && res.ok) status = "connected"; else { status = "error"; code = (r && r.error && r.error.code) || "confirm_failed"; }
  }
  to.searchParams.set("connectd", status === "connected" ? "connected" : "error");
  if (f.get("definition")) to.searchParams.set("definition", f.get("definition"));
  if (f.get("id")) to.searchParams.set("id", f.get("id"));
  if (status !== "connected") to.searchParams.set("code", code || "unknown");
  location.replace(to.href);
})();</script>`;
  return new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      "x-content-type-options": "nosniff",
    },
  });
}

export function routes(d: Deps) {
  /** Which route, and the path it's mounted under. */
  function match(req: Request) {
    const url = new URL(req.url);
    const s = url.pathname.split("/");
    const last = s.at(-1);
    // connect/:def first: a definition may be named `return` or `events`.
    if (s.at(-2) === "connect" && last) {
      let def: string | null = null;
      try {
        def = decodeURIComponent(last);
      } catch {}
      return { url, route: "connect" as const, def, base: s.slice(0, -2).join("/") };
    }
    if (last === "events" || last === "return") return { url, route: last, base: s.slice(0, -1).join("/") };
    return { url, route: null, base: "" };
  }

  async function signedIn(req: Request) {
    if (!d.user) throw new Error("connectd({ user }) is not set: oc.routes needs to know who is signed in");
    const user = await d.user(req);
    if (user === null || user === undefined || user === "") return null;
    const id = String(user);
    // `<user>:<account>` names a user's other accounts: a `:` in a user id would let one user's account be another user's connection.
    if (id.includes(":")) throw new Error(`connectd({ user }): user ids can't contain ":" (${JSON.stringify(id)}); it separates a user from their accounts`);
    return id;
  }

  /** A session token for this browser's flow (`returnUrl`), or for confirming it (`origin`). */
  const session = (def: string, id: string, a: { returnUrl: string } | { origin: string }) => d.connection(def, id).session(a);

  /** `/session/<action>` as the browser would call it: the session token, from the app's origin. */
  async function browser(origin: string, token: string, action: string, body?: unknown) {
    const res = await d.fetch(`${d.base()}/session${action ? `/${action}` : ""}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, origin, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const r = (await res.json().catch(() => null)) as { ticket?: string; flow?: string; error?: { code: string; message: string } } | null;
    return { ok: res.ok, status: res.status, r };
  }

  /** The runtime's refusals as JSON answers; anything else is the app's 500. */
  const answer = (h: (req: Request) => Promise<Response>) => (req: Request) =>
    h(req).catch((e) => {
      if (e instanceof ConnectdError) return fail(e.status, e.code, e.message);
      throw e;
    });

  async function get(req: Request): Promise<Response> {
    const m = match(req);
    const origin = d.origin ?? m.url.origin;
    if (m.route === "return") return returnPage(local(m.url.searchParams.get("return"), origin));
    if (m.route !== "connect") return fail(404, "not_found", "no such route");
    if (!m.def) return fail(400, "bad_request", "bad definition in the path");
    // Started from this app's pages (or typed in), never from another site: a cross-site link would connect the signed-in user without them asking.
    const site = req.headers.get("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "none") return fail(403, "forbidden", "start connecting from this app's pages");
    const user = await signedIn(req);
    if (!user) return fail(401, "unauthorized", "sign in first");
    const account = m.url.searchParams.get("account");
    if (account !== null && !ACCOUNT.test(account)) return fail(400, "bad_request", "account: letters, digits, _ and - only");
    const id = account ? `${user}:${account}` : user;
    const to = local(m.url.searchParams.get("return"), origin);
    const { token } = await session(m.def, id, { returnUrl: `${origin}${m.base}/return?return=${encodeURIComponent(to)}` });
    // An API-key form: the runtime's hosted page asks for it, then sends the user back to `return`.
    const info = await browser(origin, token, "");
    if (info.ok && info.r?.flow === "form") {
      const { url } = await d.connection(m.def, id).link({ next: `${origin}${to}` });
      return new Response(null, { status: 303, headers: { location: url, "cache-control": "no-store" } });
    }
    // ponytail: device codes aren't shown by any page yet; connect those from the server.
    const t = await browser(origin, token, "authorize", { mode: "redirect", nonce: "" });
    if (!t.ok || !t.r?.ticket) return fail(t.status >= 400 ? t.status : 502, t.r?.error?.code ?? "authorize_failed", t.r?.error?.message ?? "the runtime gave no ticket");
    return new Response(null, { status: 303, headers: { location: `${d.base()}/session/authorize?ticket=${encodeURIComponent(t.r.ticket)}`, "cache-control": "no-store" } });
  }

  async function post(req: Request): Promise<Response> {
    const m = match(req);
    if (m.route === "events") return d.events().handle(req);
    if (m.route !== "return") return fail(404, "not_found", "no such route");
    const origin = d.origin ?? m.url.origin;
    // A cross-site page could post a completion here with the user's cookies: only our own page may.
    if (req.headers.get("origin") !== origin) return fail(403, "forbidden", "not from this app's page");
    const user = await signedIn(req);
    if (!user) return fail(401, "unauthorized", "sign in first");
    const b = (await req.json().catch(() => null)) as { definition?: unknown; id?: unknown; completion?: unknown } | null;
    const { definition: def, id, completion } = b ?? {};
    if (typeof def !== "string" || typeof id !== "string" || typeof completion !== "string") return fail(400, "bad_request", "definition, id and completion must be strings");
    // Only the signed-in user's own connections: their id, or one of their accounts.
    if (id !== user && !id.startsWith(`${user}:`)) return fail(403, "forbidden", "not this user's connection");
    const { token } = await session(def, id, { origin });
    const c = await browser(origin, token, "complete", { completion });
    return c.ok ? Response.json({ connected: true }) : fail(c.status, c.r?.error?.code ?? "confirm_failed", c.r?.error?.message ?? "the runtime refused the completion");
  }

  return { GET: answer(get), POST: answer(post) };
}
