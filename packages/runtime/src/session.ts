import { type Credential, NotActive } from "@openconnect/connections";
import { type Json, randomId, routeTicket, sign, verify } from "@openconnect/kernel";
import { Fail, type Fault, fault, type Hosted, instanceOf, type Reply, type Settings, type Target } from "./host.ts";
import { type Api, ERROR_HEADER, type Route } from "./http.ts";
import type { Extension } from "./runtime.ts";

/**
 * Frontend connect sessions (#29). The app's backend asks for a short-lived token scoped to one
 * connection (`POST /connections/:def/:id/session`, API key); the browser uses only that token:
 *
 *   GET  /session                     what to render: flow (redirect | form), fields, state       (CORS)
 *   POST /session/connect             submit an API-key form: `{ fields }`                        (CORS)
 *   POST /session/authorize           `{ mode, nonce }` → `{ ticket }`, single use, 60 s          (CORS)
 *   GET  /session/authorize?ticket=   the popup or the page navigates here → cookie, provider     (navigation)
 *   POST /session/complete            `{ completion }` → activates; the app's page confirms       (CORS)
 *
 * The provider comes back to `/callback`, which exchanges the code but doesn't activate: it hands
 * a single-use `completion` to the app's page only (posted to `window.opener` on the token's
 * origin, or on the token's return URL), and that page confirms it with its own token. A token can
 * start and confirm an authorization of its connection, and nothing else: no token(), no proxy,
 * no status beyond the state.
 */

const TYP = "openconnect.session";
const TTL_MS = 10 * 60_000;
const MAX_TTL_MS = 60 * 60_000;
const TICKET_TTL_MS = 60_000;
/** The binding cookie lives as long as a handshake (#7). */
const COOKIE_MAX_AGE = 600;

/** A session token's payload. Signed, not secret: the browser package reads `returnUrl` to know if it can fall back to a redirect. */
export type Claims = { typ: typeof TYP; def: string; id: string; exp: number; origin: string; returnUrl?: string };

export type SessionArgs = { origin?: string; returnUrl?: string; ttlMs?: number };

/** `GET /session`: what a frontend needs to render the connect step. */
export type SessionInfo = {
  definition: string;
  id: string;
  /** `redirect`: authorize at the provider (`/session/authorize`). `form`: submit `fields` to `/session/connect`. */
  flow: "redirect" | "form";
  fields: string[];
  state: string | null;
  reason?: string;
  expiresAt: number;
};

/**
 * How an authorization ends in the browser: posted to the opener, or on the return URL as
 * `?openconnect=authorized&completion=` / `?openconnect=error&code=`. `authorized` still needs
 * `POST /session/complete`; `connected` is a flow that finished inline.
 */
export type Outcome = { status: "authorized"; completion: string } | { status: "connected" } | { status: "error"; code: string; message: string };

const bad = (m: string) => new Fail("bad_request", 400, m);
const off = () => new Fail("not_configured", 503, "sessions are off: set settings.sessions");

const parse = (u: unknown) => {
  try {
    return typeof u === "string" ? new URL(u) : null;
  } catch {
    return null;
  }
};
const originOf = (u: unknown) => parse(u)?.origin ?? null;

/** Exact match against `settings.sessions.origins`. */
const allowed = (s: Settings, origin: string | null | undefined): origin is string =>
  !!origin && origin !== "null" && !!s.sessions?.origins.some((o) => originOf(o) === origin);

/** Connection method `session`: sign a token for this connection. Runs in the instance (`d.now()`), so a revoked connection is refused here. */
async function issue(h: Hosted, a: Json): Promise<Json> {
  const s = h.settings.sessions;
  if (!s) throw off();
  const { origin, returnUrl, ttlMs = TTL_MS } = (a ?? {}) as SessionArgs;
  if (origin !== undefined && (typeof origin !== "string" || originOf(origin) !== origin)) throw bad("origin must be an origin like https://app.example.com");
  if (returnUrl !== undefined) {
    const u = parse(returnUrl);
    // Bound now, checked again on the way back: the callback never redirects anywhere the app didn't name.
    if (!u || (u.protocol !== "https:" && u.protocol !== "http:")) throw bad("returnUrl must be an http(s) URL");
    if (u.hash) throw bad("returnUrl must not have a fragment: the outcome goes there");
    if (!allowed(h.settings, u.origin)) throw new Fail("forbidden", 403, `returnUrl origin ${u.origin} is not in settings.sessions.origins`);
  }
  const o = origin ?? originOf(returnUrl);
  if (!o) throw bad("origin or returnUrl is required");
  if (!allowed(h.settings, o)) throw new Fail("forbidden", 403, `origin ${o} is not in settings.sessions.origins`);
  if (typeof ttlMs !== "number" || !Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > MAX_TTL_MS) throw bad(`ttlMs must be 1000..${MAX_TTL_MS}`);
  const rec = await h.bound.conn.read();
  if (rec?.state === "revoked") throw new NotActive("revoked", rec.reason);
  const exp = h.k.now() + ttlMs;
  const claims: Claims = { typ: TYP, def: h.def.id, id: h.id, exp, origin: o, ...(returnUrl ? { returnUrl } : {}) };
  return { token: await sign(JSON.stringify(claims), s.key), expiresAt: exp };
}

/** A signed payload of type `typ`, or a 401. `verify` is null for anything malformed, so garbage never throws. */
async function signed<T extends { typ: string }>(api: Api, value: string, typ: T["typ"]): Promise<T> {
  const s = api.settings.sessions;
  if (!s) throw off();
  const p = await verify(value, s.key);
  let c: (Partial<T> & { def?: unknown; id?: unknown }) | null = null;
  try {
    c = p ? (JSON.parse(p) as Partial<T>) : null;
  } catch {}
  if (!c || c.typ !== typ || typeof c.def !== "string" || typeof c.id !== "string") throw new Fail("unauthorized", 401, "missing or forged session token");
  if (!Object.hasOwn(api.definitions, c.def)) throw new Fail("not_found", 404, `unknown definition ${c.def}`);
  return c as T;
}

async function claimsOf(api: Api, token: string): Promise<Claims> {
  const c = await signed<Claims>(api, token, TYP);
  if (typeof c.exp !== "number" || typeof c.origin !== "string") throw new Fail("unauthorized", 401, "missing or forged session token");
  if (c.exp <= api.now()) throw new Fail("session_expired", 401, "session token expired");
  return c;
}

/** A Reply's fault, thrown as is (keeps `state`/`reason`). */
class Refused extends Error {
  constructor(readonly fault: Fault) {
    super(fault.message);
  }
}
const unwrap = (r: Reply) => {
  if ("error" in r) throw new Refused(r.error);
  return r.ok;
};

const NO_STORE = { "cache-control": "no-store", "referrer-policy": "no-referrer" };

function cookieHeader(s: Settings, c: Target["cookie"], maxAge: number) {
  // Lax: sent on the provider's top-level redirect to /callback, not on cross-site subrequests.
  return `${c.name}=${maxAge ? c.value : ""}; Path=${new URL(s.redirectUri).pathname}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

/** JSON in a <script>: nothing in it can close the tag or break the line. */
const script = (v: Json) => JSON.stringify(v).replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
const html = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The bound return URL with the outcome in its fragment, if it is still allowed. A fragment never
 * reaches a server or a Referer; it names the connection, so a page with several connect buttons
 * knows whose it is, and `resume()` removes it once read.
 */
function returnTo(s: Settings, t: Target, o: Outcome): string | null {
  if (!t.returnUrl || !allowed(s, originOf(t.returnUrl))) return null;
  const u = new URL(t.returnUrl);
  const f = new URLSearchParams({ openconnect: o.status, definition: t.definition, id: t.id });
  if (o.status === "authorized") f.set("completion", o.completion);
  if (o.status === "error") f.set("code", o.code);
  // Not secret: names the BroadcastChannel a popup cut off by COOP reports on (`resume()`).
  if (t.nonce) f.set("nonce", t.nonce);
  u.hash = f.toString();
  return u.href;
}

/**
 * End a session's authorization in the browser: redirect to the bound return URL, or a page that
 * posts the outcome to `window.opener` (only on the bound origin) and closes. A popup whose opener
 * is gone (a provider page with COOP cuts it) goes on to the return URL instead, if there is one.
 * Clears the binding cookie. The allowlist is re-checked: origins may have narrowed since the token was issued.
 */
export function complete(s: Settings, t: Target, o: Outcome): Response {
  const headers = { ...NO_STORE, "set-cookie": cookieHeader(s, t.cookie, 0) };
  const back = returnTo(s, t, o);
  if (t.mode === "redirect" && back) return new Response(null, { status: 303, headers: { ...headers, location: back } });
  if (t.mode !== "popup" || !allowed(s, t.origin)) {
    const f = { code: "forbidden", status: 403, message: "the session's origin or return URL is no longer allowed" };
    return Response.json({ error: f }, { status: f.status, headers: { ...headers, [ERROR_HEADER]: f.code } });
  }
  const message = { type: "openconnect", nonce: t.nonce, definition: t.definition, id: t.id, ...o };
  const nonce = randomId();
  const text = o.status === "error" ? `Could not connect (${o.code}). You can close this window.` : "Done. You can close this window.";
  const body = `<!doctype html><meta charset="utf-8"><title>openconnect</title><p>${html(text)}</p>
<script nonce="${nonce}">if (window.opener) { window.opener.postMessage(${script(message)}, ${script(t.origin)}); window.close(); } else if (${script(back)}) location.replace(${script(back)});</script>`;
  return new Response(body, {
    headers: {
      ...headers,
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      "x-content-type-options": "nosniff",
    },
  });
}

/**
 * `GET /session/authorize?ticket=`: the popup or the app's page navigates here. Takes the ticket
 * (once), sets the binding cookie in this browser, and sends it to the provider.
 */
async function navigate(req: Request, api: Api): Promise<Response> {
  if (req.method !== "GET") throw new Fail("method_not_allowed", 405, "GET or POST");
  if (!api.settings.sessions) throw off();
  // A kernel ticket (one-time, signed): it names the connection instance, no lookup.
  const ticket = new URL(req.url).searchParams.get("ticket") ?? "";
  const t = await routeTicket(ticket, api.settings.stateKey);
  if (!t || t.name !== "session" || !t.instance.startsWith("conn:")) throw new Fail("unauthorized", 401, "missing or forged ticket");
  const cookie = { name: `oc-${randomId(6)}`, value: randomId() };
  const reply = await api.call(t.instance, "session.authorize", { ticket, cookie });
  if ("error" in reply) throw new Fail(reply.error.code, reply.error.status, reply.error.message);
  const r = reply.ok as { target: Target; url?: string | null; error?: Fault };
  if (r.error) return complete(api.settings, r.target, { status: "error", code: r.error.code, message: r.error.message });
  if (!r.url) return complete(api.settings, r.target, { status: "connected" });
  return new Response(null, { status: 303, headers: { ...NO_STORE, location: r.url, "set-cookie": cookieHeader(api.settings, cookie, COOKIE_MAX_AGE) } });
}

function strings(v: unknown): Record<string, string> {
  if (v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string")) return v as Record<string, string>;
  throw bad("fields must be an object of strings");
}

async function state(api: Api, instance: string) {
  const r = await api.call(instance, "status", null);
  if ("error" in r && r.error.code === "not_found") return { state: null };
  const s = unwrap(r) as { state: string; reason?: string };
  return { state: s.state, ...(s.reason ? { reason: s.reason } : {}) };
}

const body = async (req: Request) => ((await req.json().catch(() => null)) ?? {}) as Record<string, unknown>;

const session: Route = {
  public: true,
  async fetch(req, api, [action, ...rest]) {
    if (action === "authorize" && !rest.length && req.method !== "POST" && req.method !== "OPTIONS") return navigate(req, api);
    const origin = req.headers.get("origin");
    const ok = allowed(api.settings, origin);
    const headers: Record<string, string> = ok ? { vary: "Origin", "access-control-allow-origin": origin, "access-control-expose-headers": ERROR_HEADER } : { vary: "Origin" };
    try {
      if (!api.settings.sessions) throw off();
      if (req.method === "OPTIONS") {
        if (!ok) throw new Fail("forbidden", 403, "origin not allowed");
        const preflight = { "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "authorization, content-type", "access-control-max-age": "600" };
        return new Response(null, { status: 204, headers: { ...headers, ...preflight } });
      }
      const auth = req.headers.get("authorization") ?? "";
      const c = await claimsOf(api, auth.startsWith("Bearer ") ? auth.slice(7) : "");
      // The token works only from the origin it was issued for (and only while that's still allowed).
      if (!ok || origin !== c.origin) throw new Fail("forbidden", 403, "origin does not match the session");
      const def = api.definitions[c.def]!;
      const instance = instanceOf(c.def, c.id);
      const flow = def.auth.callback ? "redirect" : "form";
      const post = () => {
        if (req.method !== "POST") throw new Fail("method_not_allowed", 405, "POST only");
      };
      if (rest.length) throw new Fail("not_found", 404, "no such route");
      if (!action) {
        if (req.method !== "GET") throw new Fail("method_not_allowed", 405, "GET only");
        const info: SessionInfo = { definition: c.def, id: c.id, flow, fields: def.auth.fields ?? [], ...(await state(api, instance)), expiresAt: c.exp };
        return Response.json(info, { headers });
      }
      if (action === "connect") {
        post();
        if (flow !== "form") throw bad(`${c.def} authorizes at the provider: use /session/authorize`);
        unwrap(await api.call(instance, "connect", strings((await body(req)).fields)));
        return Response.json(await state(api, instance), { headers });
      }
      if (action === "authorize") {
        // A fetch, not a form: the browser always sends the real Origin on it, whatever the page's
        // Referrer-Policy (a form POST from a `no-referrer` page says `Origin: null`).
        const { mode = "popup", nonce = "" } = await body(req);
        if (mode !== "popup" && mode !== "redirect") throw bad("mode must be popup or redirect");
        if (typeof nonce !== "string" || !/^[\w-]{0,64}$/.test(nonce)) throw bad("bad nonce");
        if (mode === "redirect" && !c.returnUrl) throw bad("redirect mode needs a returnUrl in the session");
        if (flow !== "redirect") throw bad(`${c.def} takes fields: POST /session/connect`);
        const target = { mode, nonce, origin: c.origin, ...(c.returnUrl ? { returnUrl: c.returnUrl } : {}) };
        return Response.json(unwrap(await api.call(instance, "session.ticket", target)), { headers });
      }
      if (action === "complete") {
        post();
        unwrap(await api.call(instance, "session.complete", { completion: (await body(req)).completion as Json }));
        return Response.json(await state(api, instance), { headers });
      }
      throw new Fail("not_found", 404, "no such route");
    } catch (e) {
      const f = e instanceof Refused ? e.fault : fault(e, "worker");
      return Response.json({ error: f }, { status: f.status, headers: { ...headers, [ERROR_HEADER]: f.code } });
    }
  },
};

const str = (a: Json, k: string) => {
  const v = (a as Record<string, Json> | null)?.[k];
  if (typeof v !== "string") throw bad(`${k} must be a string`);
  return v;
};

/** The instance's part: tickets and completions are stored in the connection's own instance, so they can't cross to another. */
function methods(h: Hosted): Record<string, (a: Json) => Promise<Json>> {
  type Stored = Omit<Target, "cookie" | "definition" | "id">;
  const tickets = h.k.ticket<Stored>("session", { ttlMs: TICKET_TTL_MS });
  return {
    session: (a) => issue(h, a),

    /** Mint a single-use ticket for this connection; the route checked the token and the Origin. */
    "session.ticket": async (a) => {
      if (!h.settings.sessions) throw off();
      const mode = str(a, "mode");
      if (mode !== "popup" && mode !== "redirect") throw bad("mode must be popup or redirect");
      const target: Stored = { mode, nonce: str(a, "nonce"), origin: str(a, "origin"), ...((a as { returnUrl?: Json }).returnUrl ? { returnUrl: str(a, "returnUrl") } : {}) };
      return { ticket: await tickets.issue(target) };
    },

    /** Take the ticket and open the handshake. Failures after the take come back with the target, so the browser is sent back. */
    "session.authorize": async (a) => {
      const stored = await tickets.redeem(str(a, "ticket"));
      if (!stored) throw new Fail("bad_ticket", 401, "unknown, used or expired ticket");
      const cookie = (a as { cookie: Target["cookie"] }).cookie;
      const target: Target = { ...stored, cookie: { name: String(cookie?.name), value: String(cookie?.value) }, definition: h.def.id, id: h.id };
      try {
        return { target, url: await h.bound.connect({}, target as unknown as Json) } as unknown as Json;
      } catch (e) {
        return { target, error: fault(e, h.instance) } as unknown as Json;
      }
    },

    /** The app's page confirms what the callback exchanged: check (metadata) and activate. */
    "session.complete": async (a) => {
      const sealed = await h.done.redeem(str(a, "completion"));
      if (typeof sealed !== "string") throw new Fail("bad_completion", 400, "unknown, used or expired completion");
      // Revoked while the user was at the provider: refuse before calling it (metadata) with the new credential.
      const rec = await h.bound.conn.read();
      if (rec?.state === "revoked") throw new NotActive("revoked", rec.reason);
      await h.bound.finish((await h.k.unseal(sealed)).value as unknown as Credential);
      return null;
    },
  };
}

/**
 * Frontend connect sessions (#29): `extensions: [sessions()]`, on when `settings.sessions` is set.
 * Adds the `/session` routes, the `session` connection method (token issue, API key) and the
 * internal methods only those routes call.
 */
export const sessions = (): Extension => ({
  routes: { session },
  internal: ["session.ticket", "session.authorize", "session.complete"],
  connection: (h) => ({ methods: methods(h) }),
});
