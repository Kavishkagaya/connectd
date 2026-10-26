import { type Credential, NotActive } from "@kavishkagaya/connectd-connections";
import { type Json, randomId, routeTicket, sign, verify } from "@kavishkagaya/connectd-kernel";
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

const TYP = "connectd.session";
const TTL_MS = 10 * 60_000;
const MAX_TTL_MS = 60 * 60_000;
const TICKET_TTL_MS = 60_000;
/** The binding cookie lives as long as a handshake (#7). */
const COOKIE_MAX_AGE = 600;

/** A session token's payload. Signed, not secret: the browser package reads `returnUrl` to know if it can fall back to a redirect. */
export type Claims = {
  typ: typeof TYP;
  def: string;
  id: string;
  exp: number;
  origin: string;
  returnUrl?: string;
  /** A hosted session (`link()`): used once (`jti`), from the runtime's own page; `next`, `confirm` as in SessionArgs. */
  hosted?: true;
  jti?: string;
  next?: string;
  confirm?: true;
};

/**
 * `hosted: true` (`link()` in the SDK): a session for the runtime's own connect page, `/connect`, and
 * `next` where that page sends the user once connected (`?connectd=connected&definition=&id=`).
 * `confirm: true` (needs `next`; API-key forms only): the page doesn't activate; it hands `next` the outcome in the
 * fragment (`#connectd=authorized&completion=`), like a `returnUrl`, and the app's own page confirms
 * it for the signed-in user (`oc.routes`). A hosted link works once: whoever holds it can connect.
 */
export type SessionArgs = { origin?: string; returnUrl?: string; ttlMs?: number; hosted?: boolean; next?: string; confirm?: boolean };

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
  /** A hosted session's `next`: where its page goes once connected. */
  next?: string;
  /** A hosted session the app's page (`next`) confirms. */
  confirm?: true;
};

/**
 * How an authorization ends in the browser: posted to the opener, or on the return URL as
 * `?connectd=authorized&completion=` / `?connectd=error&code=`. `authorized` still needs
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

/** The runtime's own public origin (the hosted connect page's), from where the provider comes back. */
const own = (s: Settings) => originOf(s.redirectUri);

/** Exact match against `settings.sessions.origins`. */
const allowed = (s: Settings, origin: string | null | undefined): origin is string =>
  !!origin && origin !== "null" && !!s.sessions && s.sessions.origins.some((o) => originOf(o) === origin);
/** Allowed, or the runtime's own origin: only hosted sessions are issued for it, so a target or claims bound to it came from one. */
const reachable = (s: Settings, origin: string | null | undefined): origin is string => allowed(s, origin) || (!!origin && origin === own(s));

/** Connection method `session`: sign a token for this connection. Runs in the instance (`d.now()`), so a revoked connection is refused here. */
async function issue(h: Hosted, a: Json): Promise<Json> {
  const s = h.settings.sessions;
  if (!s) throw off();
  const args = (a ?? {}) as SessionArgs;
  const { ttlMs = TTL_MS, hosted, next, confirm } = args;
  if (hosted !== undefined && typeof hosted !== "boolean") throw bad("hosted must be a boolean");
  if (confirm !== undefined && (typeof confirm !== "boolean" || (confirm && (!hosted || next === undefined)))) throw bad("confirm is for hosted sessions with a next (the app's page confirms)");
  // A provider's flow has its own confirm step: an app's returnUrl session (`oc.routes`). Here only forms.
  if (confirm && h.def.auth.callback) throw bad(`confirm is for API-key forms; ${h.def.id} authorizes at the provider: give the app's page a returnUrl session`);
  if (hosted && (args.origin !== undefined || args.returnUrl !== undefined)) throw bad("a hosted session has no origin or returnUrl: the runtime's /connect page is both");
  if (next !== undefined) {
    if (!hosted) throw bad("next is for hosted sessions (the /connect page); an app's own page has returnUrl");
    const u = parse(next);
    if (!u || (u.protocol !== "https:" && u.protocol !== "http:") || u.hash) throw bad("next must be an http(s) URL without a fragment");
    if (!allowed(h.settings, u.origin)) throw new Fail("forbidden", 403, `next origin ${u.origin} is not in settings.sessions.origins`);
  }
  if (hosted && !own(h.settings)) throw bad("hosted sessions need settings.redirectUri (the runtime's public URL)");
  const origin = hosted ? own(h.settings)! : args.origin;
  const returnUrl = hosted ? `${own(h.settings)}/connect` : args.returnUrl;
  if (origin !== undefined && (typeof origin !== "string" || originOf(origin) !== origin)) throw bad("origin must be an origin like https://app.example.com");
  if (returnUrl !== undefined) {
    const u = parse(returnUrl);
    // Bound now, checked again on the way back: the callback never redirects anywhere the app didn't name.
    if (!u || (u.protocol !== "https:" && u.protocol !== "http:")) throw bad("returnUrl must be an http(s) URL");
    if (u.hash) throw bad("returnUrl must not have a fragment: the outcome goes there");
    if (!hosted && !allowed(h.settings, u.origin)) throw new Fail("forbidden", 403, `returnUrl origin ${u.origin} is not in settings.sessions.origins`);
  }
  const o = origin ?? originOf(returnUrl);
  if (!o) throw bad("origin or returnUrl is required");
  if (!hosted && !allowed(h.settings, o)) throw new Fail("forbidden", 403, `origin ${o} is not in settings.sessions.origins`);
  if (typeof ttlMs !== "number" || !Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > MAX_TTL_MS) throw bad(`ttlMs must be 1000..${MAX_TTL_MS}`);
  const rec = await h.bound.conn.read();
  if (rec?.state === "revoked") throw new NotActive("revoked", rec.reason);
  const exp = h.k.now() + ttlMs;
  const claims: Claims = {
    typ: TYP,
    def: h.def.id,
    id: h.id,
    exp,
    origin: o,
    ...(returnUrl ? { returnUrl } : {}),
    ...(hosted ? { hosted: true, jti: randomId() } : {}),
    ...(next ? { next } : {}),
    ...(confirm ? { confirm: true } : {}),
  };
  const token = await sign(JSON.stringify(claims), s.key);
  const flow = h.def.auth.callback ? "redirect" : "form";
  // The link carries the token in its fragment: never sent to a server, a log or a Referer.
  return { token, expiresAt: exp, flow, ...(hosted ? { url: `${returnUrl}#token=${encodeURIComponent(token)}` } : {}) };
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
  if (!t.returnUrl || !reachable(s, originOf(t.returnUrl))) return null;
  const u = new URL(t.returnUrl);
  const f = new URLSearchParams({ connectd: o.status, definition: t.definition, id: t.id });
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
  if (t.mode !== "popup" || !reachable(s, t.origin)) {
    const f = { code: "forbidden", status: 403, message: "the session's origin or return URL is no longer allowed" };
    return Response.json({ error: f }, { status: f.status, headers: { ...headers, [ERROR_HEADER]: f.code } });
  }
  const message = { type: "connectd", nonce: t.nonce, definition: t.definition, id: t.id, ...o };
  const nonce = randomId();
  const text = o.status === "error" ? `Could not connect (${o.code}). You can close this window.` : "Done. You can close this window.";
  const body = `<!doctype html><meta charset="utf-8"><title>connectd</title><p>${html(text)}</p>
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
    // A same-origin GET carries no Origin: the hosted page's own fetches (Sec-Fetch-Site can't be set by a page).
    // ponytail: browsers without Fetch Metadata (Safari < 16.4) get a 403 on the page's GET; a POST for the info if anyone needs them.
    const origin = req.headers.get("origin") ?? (req.headers.get("sec-fetch-site") === "same-origin" ? own(api.settings) : null);
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
      // The token works only from the origin it was issued for (and only while that's still allowed); the runtime's own, for hosted ones.
      if (origin !== c.origin || !(ok || (c.hosted && origin === own(api.settings)))) throw new Fail("forbidden", 403, "origin does not match the session");
      const def = api.definitions[c.def]!;
      const instance = instanceOf(c.def, c.id);
      const flow = def.auth.callback ? "redirect" : "form";
      const post = () => {
        if (req.method !== "POST") throw new Fail("method_not_allowed", 405, "POST only");
      };
      if (rest.length) throw new Fail("not_found", 404, "no such route");
      if (!action) {
        if (req.method !== "GET") throw new Fail("method_not_allowed", 405, "GET only");
        if (c.jti) unwrap(await api.call(instance, "session.unused", { jti: c.jti }));
        // `next` re-checked: origins may have narrowed since the link was made.
        const next = c.next && allowed(api.settings, originOf(c.next)) ? c.next : undefined;
        const info: SessionInfo = { definition: c.def, id: c.id, flow, fields: def.auth.fields ?? [], ...(await state(api, instance)), expiresAt: c.exp, ...(next ? { next } : {}), ...(c.confirm ? { confirm: true } : {}) };
        return Response.json(info, { headers });
      }
      if (action === "connect") {
        post();
        if (flow !== "form") throw bad(`${c.def} authorizes at the provider: use /session/authorize`);
        const use = { ...(c.jti ? { jti: c.jti, exp: c.exp } : {}), ...(c.confirm ? { confirm: true } : {}) };
        const r = unwrap(await api.call(instance, "session.connect", { fields: strings((await body(req)).fields), ...use })) as { completion?: string };
        // confirm: the fields' credential waits for the app's page (`next`), like a provider's.
        return Response.json(r.completion ? { completion: r.completion } : await state(api, instance), { headers });
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
        return Response.json(unwrap(await api.call(instance, "session.ticket", { ...target, ...(c.jti ? { jti: c.jti } : {}) })), { headers });
      }
      if (action === "complete") {
        post();
        if (c.confirm) throw new Fail("forbidden", 403, "this session is confirmed by the app's page (next), not here");
        unwrap(await api.call(instance, "session.complete", { completion: (await body(req)).completion as Json, ...(c.jti ? { jti: c.jti, exp: c.exp } : {}) }));
        return Response.json(await state(api, instance), { headers });
      }
      throw new Fail("not_found", 404, "no such route");
    } catch (e) {
      const f = e instanceof Refused ? e.fault : fault(e, "front door", api.platform.log);
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
  // Hosted links used to connect: their jti until they'd have expired anyway.
  const used = h.k.cell<Record<string, number>>("session.used");
  const jtiOf = (a: Json) => {
    const v = (a as { jti?: Json } | null)?.jti;
    return typeof v === "string" ? v : null;
  };
  const unused = async (jti: string | null) => {
    if (jti && Object.hasOwn((await used.read())?.value ?? {}, jti)) throw new Fail("session_used", 401, "this link was already used: ask for a new one");
  };
  // Burned after it connects, so a mistyped key can be tried again. ponytail: two submits at once both land; the second only replaces the first's credential.
  const burn = async (a: Json) => {
    const jti = jtiOf(a);
    const exp = (a as { exp?: Json }).exp;
    if (!jti || typeof exp !== "number") return;
    const now = h.k.now();
    await used.update((cur) => ({ ...Object.fromEntries(Object.entries(cur ?? {}).filter(([, e]) => e > now)), [jti]: exp }));
  };
  return {
    session: (a) => issue(h, a),

    "session.unused": async (a) => {
      await unused(jtiOf(a));
      return null;
    },

    /** An API-key form: connect with the fields, or with `confirm`, hold their credential for the app's page (a completion). */
    "session.connect": async (a): Promise<Json> => {
      await unused(jtiOf(a));
      const fields = (a as { fields?: Json }).fields as Record<string, string>;
      if ((a as { confirm?: Json }).confirm !== true) {
        await h.bound.connect(fields);
        await burn(a);
        return {};
      }
      const rec = await h.bound.conn.read();
      if (rec?.state === "revoked") throw new NotActive("revoked", rec.reason);
      // A form's start (apiKey) only builds the credential: nothing to pend or poll, unlike bound.connect. The app's confirm checks it (metadata).
      const step = await h.def.auth.start(h.bound.ctx, fields);
      if (!("credential" in step)) throw bad(`${h.def.id} authorizes at the provider: use /session/authorize`);
      const completion = await h.done.issue(await h.k.seal(step.credential as unknown as Json));
      await burn(a);
      return { completion };
    },

    /** Mint a single-use ticket for this connection; the route checked the token and the Origin. */
    "session.ticket": async (a) => {
      if (!h.settings.sessions) throw off();
      // ponytail: device flows show a code the browser would need to display; start them from the server (connect) for now.
      if (h.def.auth.poll) throw bad("device flows don't run in a browser session; connect from the server and show the code");
      await unused(jtiOf(a));
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
        return { target, error: fault(e, h.instance, h.platform.log) } as unknown as Json;
      }
    },

    /** The app's page confirms what the callback exchanged: check (metadata) and activate. */
    "session.complete": async (a) => {
      await unused(jtiOf(a));
      const sealed = await h.done.redeem(str(a, "completion"));
      if (typeof sealed !== "string") throw new Fail("bad_completion", 400, "unknown, used or expired completion");
      // Revoked while the user was at the provider: refuse before calling it (metadata) with the new credential.
      const rec = await h.bound.conn.read();
      if (rec?.state === "revoked") throw new NotActive("revoked", rec.reason);
      await h.bound.finish((await h.k.unseal(sealed)).value as unknown as Credential);
      await burn(a);
      return null;
    },
  };
}

/**
 * `GET /connect#token=`: the runtime's own connect page (#54, `link()`), so an app needs no frontend
 * package. It keeps the token in sessionStorage (the provider round trip leaves the page), then
 * renders a button (redirect flows) or a form (API-key fields) on the same `/session` API as
 * @kavishkagaya/connectd-connect, from the runtime's own origin. Back from the provider it confirms, then goes
 * to the session's `next`.
 */
const hostedPage: Route = {
  public: true,
  async fetch(req, api, rest) {
    if (rest.length) throw new Fail("not_found", 404, "no such route");
    if (req.method !== "GET") throw new Fail("method_not_allowed", 405, "GET only");
    if (!api.settings.sessions) throw off();
    const nonce = randomId();
    return new Response(page(nonce), {
      headers: {
        ...NO_STORE,
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        "x-content-type-options": "nosniff",
      },
    });
  },
};

// ponytail: one plain page, no theming; the dashboard's look or per-app branding when someone asks.
const page = (nonce: string) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect</title>
<style nonce="${nonce}">body{font:16px/1.5 system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;color:#222}button{font:inherit;padding:.5rem 1rem;cursor:pointer}label{display:block;margin:.75rem 0}input{display:block;width:100%;font:inherit;padding:.4rem;box-sizing:border-box}.err{color:#b00020}</style>
<main id="m"><p>Loading…</p></main>
<script nonce="${nonce}">(async () => {
  const KEY = "connectd.session", m = document.getElementById("m");
  const f = new URLSearchParams(location.hash.slice(1));
  if (f.get("token")) sessionStorage.setItem(KEY, f.get("token"));
  history.replaceState(null, "", location.pathname);
  const token = sessionStorage.getItem(KEY);
  const el = (tag, props, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
  const show = (...kids) => m.replaceChildren(...kids);
  const fail = (msg) => show(el("h1", { textContent: "Couldn't connect" }), el("p", { className: "err", textContent: msg }));
  if (!token) return fail("This link has expired or was already used. Ask for a new one.");
  const api = async (path, body) => {
    const res = await fetch("/session" + path, { method: body ? "POST" : "GET", headers: { authorization: "Bearer " + token, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const r = await res.json().catch(() => null);
    if (!res.ok) throw new Error((r && r.error && r.error.message) || "HTTP " + res.status);
    return r;
  };
  let info;
  try { info = await api(""); } catch (e) { sessionStorage.removeItem(KEY); return fail(e.message); }
  if (info.confirm && !info.next) { sessionStorage.removeItem(KEY); return fail("This link no longer goes anywhere. Ask for a new one."); }
  const done = () => {
    sessionStorage.removeItem(KEY);
    if (!info.next) return show(el("h1", { textContent: "Connected" }), el("p", { textContent: info.definition + " is connected. You can close this tab." }));
    const to = new URL(info.next);
    to.searchParams.set("connectd", "connected"); to.searchParams.set("definition", info.definition); to.searchParams.set("id", info.id);
    location.replace(to.href);
  };
  // confirm: the app's page (next) confirms it for its signed-in user, the outcome in the fragment as on a returnUrl.
  const hand = (completion) => {
    sessionStorage.removeItem(KEY);
    const to = new URL(info.next);
    to.hash = new URLSearchParams({ connectd: "authorized", definition: info.definition, id: info.id, completion }).toString();
    location.replace(to.href);
  };
  try {
    if (f.get("connectd") === "authorized") { await api("/complete", { completion: f.get("completion") }); return done(); }
    if (f.get("connectd") === "connected") return done();
    const again = f.get("connectd") === "error" ? el("p", { className: "err", textContent: "That didn't work (" + (f.get("code") || "error") + "). Try again." }) : "";
    if (info.flow === "redirect") {
      const b = el("button", { textContent: "Connect " + info.definition });
      b.onclick = async () => { b.disabled = true; try { const t = await api("/authorize", { mode: "redirect", nonce: "" }); location.assign("/session/authorize?ticket=" + encodeURIComponent(t.ticket)); } catch (e) { b.disabled = false; fail(e.message); } };
      return show(el("h1", { textContent: "Connect " + info.definition }), again, b);
    }
    const inputs = info.fields.map((name) => el("input", { name, type: "password", autocomplete: "off", required: true }));
    const b = el("button", { type: "submit", textContent: "Connect" }), err = el("p", { className: "err" });
    const form = el("form", {}, ...inputs.map((i) => el("label", { textContent: i.name }, i)), err, b);
    form.onsubmit = async (ev) => {
      ev.preventDefault();
      if (b.disabled) return;
      b.disabled = true; err.textContent = "";
      try { const r = await api("/connect", { fields: Object.fromEntries(inputs.map((i) => [i.name, i.value])) }); return r.completion ? hand(r.completion) : done(); }
      catch (e) { err.textContent = e.message; b.disabled = false; }
    };
    show(el("h1", { textContent: "Connect " + info.definition }), again, form);
  } catch (e) { fail(e.message); }
})();</script>`;

/**
 * Frontend connect sessions (#29): `extensions: [sessions()]`, on when `settings.sessions` is set.
 * Adds the `/session` routes, the `session` connection method (token issue, API key) and the
 * internal methods only those routes call.
 */
export const sessions = (): Extension => ({
  routes: { session, connect: hostedPage },
  internal: ["session.ticket", "session.authorize", "session.complete", "session.connect", "session.unused"],
  connection: (h) => ({ methods: methods(h) }),
});
