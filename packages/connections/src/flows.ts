import type { Json } from "@openconnect/kernel";
import { apiKey as apiKeySteps, deadAs, type OAuth2Config, type OAuth2Spec, oauth2Steps } from "./auth.ts";
import type { Auth, Ctx } from "./define.ts";
import { type Claims, decodeJwt, type Jwk, signingKey, signJwt, verifyJwt } from "./jwt.ts";
import { type Credential, credentialFrom, type OAuth2 } from "./lifecycle.ts";
import { type Client, clientCredentials, deviceAuthorize, devicePoll, OAuthError, refreshGrant, type TokenResponse } from "./oauth.ts";

/**
 * The auth flows `.auth()` hands its callback (#54, #56), each a builder: data in the constructor,
 * quirks as methods, every method returning a new flow.
 */

// `Symbol.for`: a config bundled with its own copy of this package (`openconnect dev`) still matches.
export const STEPS = Symbol.for("openconnect.flow");
export const IDENTITY = Symbol.for("openconnect.flow.identity");

/** An auth flow, as `.auth()` takes it. `M` is the identity it provides by itself (OIDC: the id_token's claims). */
export type Flow<C, M extends Json = null> = { readonly [STEPS]: Auth<C>; readonly [IDENTITY]?: (cred: Credential) => M };

/** The standard step (or the override before this one), for an override to call. */
type Next<A, R> = (a: A) => Promise<R>;
type Override<C, A, R> = (ctx: Ctx<C>, a: A, next: Next<A, R>) => Promise<R>;

/** Code for tokens. Return the token response; the flow turns it into the credential. */
export type CallbackStep<C> = Override<C, Record<string, string>, TokenResponse>;
/** Refresh token for tokens. A provider code passed to `deadRefreshToken` still means `invalid_grant`. */
export type RefreshStep<C> = Override<C, OAuth2, TokenResponse>;
export type RevokeStep<C> = Override<C, Credential, void>;

/** Authorization code (+ PKCE) as a builder. */
export interface OAuth2Flow<C, M extends Json = null> extends Flow<C, M> {
  /** Default scopes; replaces earlier ones. Config `scopes` and the connect call's `scope` take precedence. */
  scopes(...scopes: string[]): OAuth2Flow<C, M>;
  /** Default " ". */
  scopeSeparator(separator: string): OAuth2Flow<C, M>;
  /** Extra authorize params (Google `access_type`); a function when they come from config. */
  params(params: Record<string, string> | ((config: C) => Record<string, string>)): OAuth2Flow<C, M>;
  /** Default on. */
  pkce(on: boolean): OAuth2Flow<C, M>;
  clientAuth(how: "basic" | "post"): OAuth2Flow<C, M>;
  /** The provider's error codes for a dead refresh token (GitHub `bad_refresh_token`). */
  deadRefreshToken(...codes: string[]): OAuth2Flow<C, M>;
  /** Override a step: call `next` to run the standard one and adjust its result, or don't, to replace it. */
  callback(step: CallbackStep<C>): OAuth2Flow<C, M>;
  refresh(step: RefreshStep<C>): OAuth2Flow<C, M>;
  revoke(step: RevokeStep<C>): OAuth2Flow<C, M>;
}

type Endpoints = { authorizeUrl: string; tokenUrl: string; revokeUrl?: string };

type OAuth2State<C> = {
  spec: OAuth2Spec<C>;
  /** OIDC: endpoints from discovery, the nonce, the id_token checked. */
  issuer?: string;
  callback?: CallbackStep<C>;
  refresh?: RefreshStep<C>;
  revoke?: RevokeStep<C>;
};

/** `step` around `prev`: inside `step`, `next` is the step as it was before (the standard one at the bottom). */
const around =
  <C, A, R>(prev: Override<C, A, R> | undefined, step: Override<C, A, R>): Override<C, A, R> =>
  (ctx, a, next) =>
    step(ctx, a, (b) => (prev ? prev(ctx, b, next) : next(b)));

const run = <C, A, R>(o: Override<C, A, R> | undefined, ctx: Ctx<C>, a: A, std: Next<A, R>) => (o ? o(ctx, a, std) : std(a));

const client = (ctx: Ctx<OAuth2Config>, how?: "basic" | "post"): Client => ({
  clientId: ctx.config.clientId,
  redirectUri: ctx.redirectUri,
  ...(ctx.config.clientSecret !== undefined ? { clientSecret: ctx.config.clientSecret } : {}),
  ...(how ? { auth: how } : {}),
});

const scopeOf = (ctx: Ctx<OAuth2Config>, input: Record<string, string>, scopes?: string[], sep = " ") =>
  input.scope ?? (ctx.config.scopes ?? scopes)?.join(sep);

// --- OIDC discovery and keys, cached per isolate (#56) ---

type Discovery = { issuer: string; authorization_endpoint: string; token_endpoint: string; revocation_endpoint?: string; jwks_uri: string };

// ponytail: per isolate, fetched at login; move to an app-wide instance (`app:<def>`) with a TTL if discovery is ever needed per request.
const discovered = new Map<string, Promise<Discovery>>();
const keySets = new Map<string, Promise<Jwk[]>>();

function cached<T>(m: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  let p = m.get(key);
  if (!p) {
    p = load();
    m.set(key, p);
    p.catch(() => m.delete(key));
  }
  return p;
}

async function json<T>(f: typeof fetch, url: string): Promise<T> {
  const res = await f(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return (await res.json()) as T;
}

const trim = (u: string) => u.replace(/\/+$/, "");

/** The issuer's metadata, which must name the issuer it was fetched from (OIDC Discovery §4.3). */
const discover = (f: typeof fetch, issuer: string) =>
  cached(discovered, issuer, async () => {
    const d = await json<Discovery>(f, `${trim(issuer)}/.well-known/openid-configuration`);
    // Microsoft's multi-tenant endpoints (`common`, `organizations`) answer with a `{tenantid}` template instead.
    if (!d.issuer.includes("{tenantid}") && trim(d.issuer) !== trim(issuer)) throw new Error(`discovery for ${issuer} names issuer ${d.issuer}`);
    return d;
  });

/**
 * An id_token's claims, after checking its signature (keys refetched once on an unknown `kid`),
 * issuer, audience (and `azp` with several), expiry and nonce. On Microsoft's multi-tenant
 * endpoints any tenant passes: an app that serves only some restricts on the `tid` claim.
 */
export async function verifyIdToken(f: typeof fetch, d: Discovery, token: string, o: { clientId: string; nonce: string; now: number }): Promise<Claims> {
  const keys = () => cached(keySets, d.jwks_uri, async () => (await json<{ keys: Jwk[] }>(f, d.jwks_uri)).keys);
  let claims = await verifyJwt(token, await keys());
  if (!claims) {
    keySets.delete(d.jwks_uri);
    claims = await verifyJwt(token, await keys());
  }
  if (!claims) throw new OAuthError("invalid_id_token", 400, "no key for the id_token's kid");
  // Microsoft's multi-tenant metadata says `{tenantid}`; the token's `tid` fills it in.
  const iss = d.issuer.replace("{tenantid}", String(claims.tid ?? ""));
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const bad =
    claims.iss !== iss
      ? "iss"
      : !aud.includes(o.clientId)
        ? "aud"
        : aud.length > 1 && claims.azp !== o.clientId
          ? "azp"
        : typeof claims.exp !== "number" || claims.exp * 1000 < o.now - 60_000
          ? "exp"
          : claims.nonce !== o.nonce
            ? "nonce"
            : null;
  if (bad) throw new OAuthError("invalid_id_token", 400, `id_token ${bad} doesn't match`);
  return claims;
}

/** The id_token's claims from an OIDC credential (checked when it was issued). */
export function idClaims(cred: Credential): Claims {
  const t = cred.kind === "oauth2" ? cred.raw.id_token : undefined;
  if (typeof t !== "string") throw new Error("no id_token in the credential; keep the openid scope");
  return decodeJwt(t).claims;
}

function oauth2Flow<C extends OAuth2Config, M extends Json = null>(st: OAuth2State<C>): OAuth2Flow<C, M> {
  const set = (p: Partial<OAuth2Spec<C>>) => oauth2Flow<C, M>({ ...st, spec: { ...st.spec, ...p } });
  /** The standard steps, on endpoints from discovery for OIDC. */
  const steps = async (ctx: Ctx<C>) => {
    if (!st.issuer) return { s: oauth2Steps(st.spec), d: null };
    const d = await discover(ctx.fetch, st.issuer);
    const spec = { ...st.spec, authorizeUrl: d.authorization_endpoint, tokenUrl: d.token_endpoint, ...(d.revocation_endpoint ? { revokeUrl: d.revocation_endpoint } : {}) };
    return { s: oauth2Steps(spec), d };
  };
  const auth: Auth<C> = {
    async start(ctx, input) {
      const { s, d } = await steps(ctx);
      const step = await s.start(ctx, input);
      if (!d || !("redirect" in step)) return step;
      const nonce = crypto.randomUUID();
      return {
        data: { ...(step.data as Record<string, Json> | null), nonce },
        redirect: (state) => {
          const u = new URL(step.redirect(state));
          u.searchParams.set("nonce", nonce);
          return u.toString();
        },
      };
    },
    async callback(ctx, params, data) {
      const { s, d } = await steps(ctx);
      const tok = await run(st.callback, ctx, params, (p) => s.exchange(ctx, p, data));
      if (d) {
        if (typeof tok.id_token !== "string") throw new OAuthError("invalid_response", 200, "no id_token; keep the openid scope");
        const nonce = String((data as { nonce?: string } | null)?.nonce ?? "");
        await verifyIdToken(ctx.fetch, d, tok.id_token, { clientId: ctx.config.clientId, nonce, now: ctx.now() });
      }
      return credentialFrom(tok, ctx.now());
    },
    refresh: async (ctx, cred) => {
      const { s } = await steps(ctx);
      return deadAs(st.spec.invalidGrant, run(st.refresh, ctx, cred, (c) => s.grant(ctx, c)));
    },
    ...(st.spec.revokeUrl || st.revoke || st.issuer
      ? {
          revoke: async (ctx: Ctx<C>, cred: Credential) => {
            const { s } = await steps(ctx);
            return run(st.revoke, ctx, cred, (c) => s.revoke(ctx, c));
          },
        }
      : {}),
  };
  return {
    [STEPS]: auth,
    ...(st.issuer ? { [IDENTITY]: idClaims as unknown as (cred: Credential) => M } : {}),
    scopes: (...scopes) => set({ scopes: st.issuer && !scopes.includes("openid") ? ["openid", ...scopes] : scopes }),
    scopeSeparator: (scopeSeparator) => set({ scopeSeparator }),
    params: (params) => set({ params }),
    pkce: (on) => set({ pkce: on }),
    clientAuth: (clientAuth) => set({ clientAuth }),
    deadRefreshToken: (...invalidGrant) => set({ invalidGrant }),
    callback: (step) => oauth2Flow<C, M>({ ...st, callback: around(st.callback, step) }),
    refresh: (step) => oauth2Flow<C, M>({ ...st, refresh: around(st.refresh, step) }),
    revoke: (step) => oauth2Flow<C, M>({ ...st, revoke: around(st.revoke, step) }),
  };
}

/** A token minted from what the app holds, with no user: scopes and how the client authenticates. */
export interface MintFlow<C> extends Flow<C> {
  scopes(...scopes: string[]): MintFlow<C>;
  clientAuth(how: "basic" | "post"): MintFlow<C>;
}

type MintState = { tokenUrl: string; audience?: string; scopes?: string[]; how?: "basic" | "post" };

/** Steps for a flow that mints: the credential at connect, a new token on refresh, nothing to revoke at the provider. */
function minting<C>(mint: (ctx: Ctx<C>, data: Json | undefined) => Promise<TokenResponse>): Auth<C> {
  return {
    mints: true,
    async start(ctx, input) {
      const data = input.subject ? { subject: input.subject } : undefined;
      const cred = credentialFrom(await mint(ctx, data), ctx.now());
      return { credential: data ? { ...cred, data } : cred };
    },
    refresh: (ctx, cred) => mint(ctx, cred.data),
  };
}

function clientCredentialsFlow(st: MintState): MintFlow<OAuth2Config> {
  return {
    [STEPS]: minting<OAuth2Config>((ctx) => clientCredentials(ctx.fetch, st.tokenUrl, client(ctx, st.how), scopeOf(ctx, {}, st.scopes))),
    scopes: (...scopes) => clientCredentialsFlow({ ...st, scopes }),
    clientAuth: (how) => clientCredentialsFlow({ ...st, how }),
  };
}

/** A service account's key (Google's JSON key file: `client_email`, `private_key`). */
export type ServiceAccount = { clientEmail: string; privateKey: string; scopes?: string[] };

/** JWT bearer: scopes only (the key is the client's authentication). */
export interface JwtFlow<C> extends Flow<C> {
  scopes(...scopes: string[]): JwtFlow<C>;
}

function jwtBearerFlow(st: MintState): JwtFlow<ServiceAccount> {
  const mint = async (ctx: Ctx<ServiceAccount>, data: Json | undefined) => {
    const key = await signingKey(ctx.config.privateKey);
    const iat = Math.floor(ctx.now() / 1000);
    const scope = (ctx.config.scopes ?? st.scopes)?.join(" ");
    const subject = (data as { subject?: string } | undefined)?.subject;
    const assertion = await signJwt(
      { iss: ctx.config.clientEmail, aud: st.audience ?? st.tokenUrl, iat, exp: iat + 3600, ...(scope ? { scope } : {}), ...(subject ? { sub: subject } : {}) },
      key,
    );
    // No client id or secret: the signed assertion is the client's authentication.
    const res = await ctx.fetch(st.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    });
    const tok = (await res.json().catch(() => null)) as TokenResponse | null;
    if (res.ok && tok && typeof tok.error !== "string") return tok;
    const code = String(tok?.error ?? "invalid_response");
    // A bad assertion or a disabled account: only new config fixes it.
    throw new OAuthError(code === "unauthorized_client" ? "invalid_grant" : code, res.status, tok);
  };
  return {
    [STEPS]: minting(mint),
    scopes: (...scopes) => jwtBearerFlow({ ...st, scopes }),
  };
}

/** Device authorization (RFC 8628): the user enters a code on another device while the runtime polls. */
export interface DeviceFlow<C> extends Flow<C> {
  scopes(...scopes: string[]): DeviceFlow<C>;
  deadRefreshToken(...codes: string[]): DeviceFlow<C>;
}

type DeviceState = { deviceUrl: string; tokenUrl: string; scopes?: string[]; dead?: string[] };

function deviceFlow(st: DeviceState): DeviceFlow<OAuth2Config> {
  const auth: Auth<OAuth2Config> = {
    async start(ctx, input) {
      const a = await deviceAuthorize(ctx.fetch, st.deviceUrl, client(ctx), scopeOf(ctx, input, st.scopes));
      return {
        device: {
          userCode: a.user_code,
          verificationUri: a.verification_uri,
          ...(a.verification_uri_complete ? { verificationUriComplete: a.verification_uri_complete } : {}),
          // RFC 8628 requires expires_in; 15 min if a provider leaves it out. Interval: 5 s by default, never under 1 s.
          expiresAt: ctx.now() + (Number(a.expires_in) > 0 ? Number(a.expires_in) : 900) * 1000,
          intervalMs: Math.max(1, Number(a.interval) || 5) * 1000,
        },
        data: { deviceCode: a.device_code },
      };
    },
    async poll(ctx, data) {
      try {
        return credentialFrom(await devicePoll(ctx.fetch, st.tokenUrl, client(ctx), (data as { deviceCode: string }).deviceCode), ctx.now());
      } catch (e) {
        if (e instanceof OAuthError && e.code === "authorization_pending") return null;
        throw e;
      }
    },
    refresh: (ctx, cred) => deadAs(st.dead, refreshGrant(ctx.fetch, st.tokenUrl, client(ctx), cred.refreshToken as string)),
  };
  return {
    [STEPS]: auth,
    scopes: (...scopes) => deviceFlow({ ...st, scopes }),
    deadRefreshToken: (...dead) => deviceFlow({ ...st, dead }),
  };
}

type Needs<C, Need, F> = C extends Need ? F : { error: `this flow needs a config with ${keyof Need & string}` };

/** The flows `.auth()` hands its callback, bound to the connection's config type. */
export type Flows<C> = {
  /** Authorization code + PKCE. */
  oauth2: Needs<C, OAuth2Config, (endpoints: Endpoints) => OAuth2Flow<C>>;
  /** OpenID Connect: endpoints from the issuer's discovery document, the id_token verified, and its claims as the default identity. */
  oidc: Needs<C, OAuth2Config, (o: { issuer: string }) => OAuth2Flow<C, Claims>>;
  /** The app's own token (client credentials grant): no user, minted again when it expires. */
  clientCredentials: Needs<C, OAuth2Config, (o: { tokenUrl: string }) => MintFlow<C>>;
  /** A JWT signed with a service account's key, traded for a token (RFC 7523; Google service accounts). `connect({ subject })` acts as that user (domain-wide delegation). */
  jwtBearer: Needs<C, ServiceAccount, (o: { tokenUrl: string; audience?: string }) => JwtFlow<C>>;
  /** Device authorization (RFC 8628): `connect()` returns a code to show; the runtime polls until the user approves. */
  device: Needs<C, OAuth2Config, (o: { deviceUrl: string; tokenUrl: string }) => DeviceFlow<C>>;
  /** A static credential from fields the user enters (API key, username + password). `identity` checks it. */
  apiKey(...fields: string[]): Flow<C>;
  /** A fully custom flow, written as steps (the OAuth atoms in `oauth.ts` help). */
  flow(steps: Auth<C>): Flow<C>;
};

export const flows = {
  oauth2: (endpoints: Endpoints) => oauth2Flow<OAuth2Config>({ spec: endpoints }),
  oidc: (o: { issuer: string }) => oauth2Flow<OAuth2Config, Claims>({ spec: { authorizeUrl: "", tokenUrl: "", scopes: ["openid"] }, issuer: o.issuer }),
  clientCredentials: (o: { tokenUrl: string }) => clientCredentialsFlow({ tokenUrl: o.tokenUrl }),
  jwtBearer: (o: { tokenUrl: string; audience?: string }) => jwtBearerFlow({ ...o }),
  device: (o: { deviceUrl: string; tokenUrl: string }) => deviceFlow({ ...o }),
  apiKey: (...fields: string[]) => ({ [STEPS]: apiKeySteps(fields) }),
  flow: (steps: Auth<unknown>) => ({ [STEPS]: steps }),
};
