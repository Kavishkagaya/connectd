import { type Json, NotActive, randomId, sign, verify } from "@openconnect/kernel";
import { Fail, type Fault, fault, type Hosted, instanceOf, type Reply, type Settings, type Target } from "./host.ts";
import { type Api, ERROR_HEADER, type Route } from "./http.ts";
import type { Extension } from "./runtime.ts";

/**
 * Frontend connect sessions (#29). The app's backend asks for a short-lived token scoped to one
 * connection (`POST /connections/:def/:id/session`, API key); the browser uses only that token:
 *
 *   GET  /session              what to render: flow (redirect | form), fields, state      (CORS)
 *   POST /session/connect      submit an API-key form: `{ fields }`                       (CORS)
 *   POST /session/authorize    form submit (top-level, popup or same window) → provider   (navigation)
 *
 * The provider comes back to `/callback`, which redirects to the token's return URL or answers a
 * page that posts the result to `window.opener` on the token's origin. A token can start an
 * authorization and nothing else: no token(), no proxy, no status beyond the state.
 */

const TYP = "openconnect.session";
const TTL_MS = 10 * 60_000;
const MAX_TTL_MS = 60 * 60_000;
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

/** What a session ends with: posted to the opener, or as `?openconnect=connected|error&code=` on the return URL. */
export type Outcome = { status: "connected" } | { status: "error"; code: string; message: string };

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
    if (!allowed(h.settings, u.origin)) throw new Fail("forbidden", 403, `returnUrl origin ${u.origin} is not in settings.sessions.origins`);
  }
  const o = origin ?? originOf(returnUrl);
  if (!o) throw bad("origin or returnUrl is required");
  if (!allowed(h.settings, o)) throw new Fail("forbidden", 403, `origin ${o} is not in settings.sessions.origins`);
  if (typeof ttlMs !== "number" || !Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > MAX_TTL_MS) throw bad(`ttlMs must be 1000..${MAX_TTL_MS}`);
  const rec = await h.bound.conn.read();
  if (rec?.state === "revoked") throw new NotActive("revoked", rec.reason);
  const exp = h.d.now() + ttlMs;
  const claims: Claims = { typ: TYP, def: h.def.id, id: h.id, exp, origin: o, ...(returnUrl ? { returnUrl } : {}) };
  return { token: await sign(JSON.stringify(claims), s.key), expiresAt: exp };
}

async function claimsOf(api: Api, token: string): Promise<Claims> {
  const s = api.settings.sessions;
  if (!s) throw off();
  const p = await verify(token, s.key);
  let c: Partial<Claims> | null = null;
  try {
    c = p ? (JSON.parse(p) as Partial<Claims>) : null;
  } catch {}
  if (!c || c.typ !== TYP || typeof c.def !== "string" || typeof c.id !== "string" || typeof c.exp !== "number" || typeof c.origin !== "string")
    throw new Fail("unauthorized", 401, "missing or forged session token");
  if (c.exp <= api.now()) throw new Fail("session_expired", 401, "session token expired");
  if (!Object.hasOwn(api.definitions, c.def)) throw new Fail("not_found", 404, `unknown definition ${c.def}`);
  return c as Claims;
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
 * End a session's authorization in the browser: redirect to the bound return URL, or a page that
 * posts the outcome to `window.opener` (only on the bound origin) and closes. Clears the binding cookie.
 */
export function complete(s: Settings, t: Target, error: Fault | null): Response {
  const outcome: Outcome = error ? { status: "error", code: error.code, message: error.message } : { status: "connected" };
  const headers = { ...NO_STORE, "set-cookie": cookieHeader(s, t.cookie, 0) };
  // Allowlist re-checked: the origins may have narrowed since the token was issued.
  if (t.mode === "redirect" && t.returnUrl && allowed(s, originOf(t.returnUrl))) {
    const u = new URL(t.returnUrl);
    u.searchParams.set("openconnect", outcome.status);
    if (error) u.searchParams.set("code", error.code);
    return new Response(null, { status: 303, headers: { ...headers, location: u.href } });
  }
  if (t.mode !== "popup" || !allowed(s, t.origin)) {
    const f = error ?? { code: "forbidden", status: 403, message: "the session's origin is no longer allowed" };
    return Response.json({ error: f }, { status: f.status, headers: { ...headers, [ERROR_HEADER]: f.code } });
  }
  const message = { type: "openconnect", nonce: t.nonce, definition: t.definition, id: t.id, ...outcome };
  const nonce = randomId();
  const text = error ? `Could not connect (${error.code}). You can close this window.` : "Connected. You can close this window.";
  const body = `<!doctype html><meta charset="utf-8"><title>openconnect</title><p>${html(text)}</p>
<script nonce="${nonce}">if (window.opener) window.opener.postMessage(${script(message)}, ${script(t.origin)}); window.close();</script>`;
  return new Response(body, {
    status: error ? error.status : 200,
    headers: {
      ...headers,
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      "x-content-type-options": "nosniff",
    },
  });
}

/** `POST /session/authorize`: a form submitted by the app's page, top level (popup or same window). */
async function authorize(req: Request, api: Api): Promise<Response> {
  if (!api.settings.sessions) throw off();
  if (req.method !== "POST") throw new Fail("method_not_allowed", 405, "POST only: submit a form from the app's page");
  const form = await req.formData().catch(() => null);
  if (!form) throw bad("expected a form body");
  const c = await claimsOf(api, String(form.get("token") ?? ""));
  // A cross-site form POST carries Origin, so only the app's own page can start a flow with its
  // token (a link or another site's form can't push a victim through someone else's flow).
  if (req.headers.get("origin") !== c.origin || !allowed(api.settings, c.origin)) throw new Fail("forbidden", 403, "origin does not match the session");
  const mode = String(form.get("mode") ?? "popup");
  const nonce = String(form.get("nonce") ?? "");
  if (mode !== "popup" && mode !== "redirect") throw bad("mode must be popup or redirect");
  if (!/^[\w-]{0,64}$/.test(nonce)) throw bad("bad nonce");
  if (mode === "redirect" && !c.returnUrl) throw bad("redirect mode needs a returnUrl in the session");
  if (!api.definitions[c.def]?.auth.callback) throw bad(`${c.def} takes fields: POST /session/connect`);
  const target: Target = {
    mode,
    origin: c.origin,
    ...(c.returnUrl ? { returnUrl: c.returnUrl } : {}),
    nonce,
    cookie: { name: `oc-${randomId(6)}`, value: randomId() },
    definition: c.def,
    id: c.id,
  };
  // ponytail: no per-session input (scopes): the definition's or config's apply. Bind `input` into the token when an app needs per-user scopes.
  const r = await api.call(instanceOf(c.def, c.id), "session.authorize", target as unknown as Json);
  if ("error" in r) return complete(api.settings, target, r.error);
  const url = (r.ok as { url: string | null }).url;
  if (url === null) return complete(api.settings, target, null);
  return new Response(null, { status: 303, headers: { ...NO_STORE, location: url, "set-cookie": cookieHeader(api.settings, target.cookie, COOKIE_MAX_AGE) } });
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

const session: Route = {
  public: true,
  async fetch(req, api, [action, ...rest]) {
    if (action === "authorize" && !rest.length) return authorize(req, api);
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
      if (!action && !rest.length) {
        if (req.method !== "GET") throw new Fail("method_not_allowed", 405, "GET only");
        const info: SessionInfo = { definition: c.def, id: c.id, flow, fields: def.auth.fields ?? [], ...(await state(api, instance)), expiresAt: c.exp };
        return Response.json(info, { headers });
      }
      if (action === "connect" && !rest.length) {
        if (req.method !== "POST") throw new Fail("method_not_allowed", 405, "POST only");
        if (flow !== "form") throw bad(`${c.def} authorizes at the provider: submit a form to /session/authorize`);
        const body = (await req.json().catch(() => null)) as { fields?: unknown } | null;
        unwrap(await api.call(instance, "connect", strings(body?.fields)));
        return Response.json(await state(api, instance), { headers });
      }
      throw new Fail("not_found", 404, "no such route");
    } catch (e) {
      const f = e instanceof Refused ? e.fault : fault(e, "worker");
      return Response.json({ error: f }, { status: f.status, headers: { ...headers, [ERROR_HEADER]: f.code } });
    }
  },
};

function target(a: Json): Target {
  const t = a as Partial<Target> | null;
  if (!t || (t.mode !== "popup" && t.mode !== "redirect") || typeof t.origin !== "string" || typeof t.cookie?.value !== "string") throw bad("bad target");
  return t as Target;
}

/**
 * Frontend connect sessions (#29): `extensions: [sessions()]`, on when `settings.sessions` is set.
 * Adds the `/session` routes, the `session` connection method (token issue, API key) and the
 * internal `session.authorize` (only the route calls it, after checking the token and origin).
 */
export const sessions = (): Extension => ({
  routes: { session },
  internal: ["session.authorize"],
  connection: (h) => ({
    methods: {
      session: (a) => issue(h, a),
      "session.authorize": async (a) => ({ url: await h.bound.connect({}, { ...target(a), definition: h.def.id, id: h.id } as unknown as Json) }),
    },
  }),
});
