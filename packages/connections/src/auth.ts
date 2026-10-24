import { type Auth, type Ctx, InputError } from "./define.ts";
import type { Json } from "@connectd/kernel";
import { type Credential, credentialFrom, type OAuth2 } from "./lifecycle.ts";
import { authorizeUrl, type Client, exchangeCode, OAuthError, pkce, refreshGrant, revoke, type TokenResponse } from "./oauth.ts";

/** Auth step builders for the common flows. Quirks are config when they're data, hooks when they're behaviour. */

/** Per-app connector config. `scopes` overrides the definition's defaults. */
export type OAuth2Config = { clientId: string; clientSecret?: string; scopes?: string[] };

export type OAuth2Spec<C> = {
  authorizeUrl: string;
  tokenUrl: string;
  revokeUrl?: string;
  scopes?: string[];
  /** Default " "; some providers want ",". */
  scopeSeparator?: string;
  /** Default true. */
  pkce?: boolean;
  clientAuth?: "basic" | "post";
  /** Extra authorize params, e.g. Google's `access_type: "offline"`; a function when they come from config. */
  params?: Record<string, string> | ((config: C) => Record<string, string>);
  /** Provider error codes that mean the refresh token is dead (GitHub: `bad_refresh_token`). */
  invalidGrant?: string[];
  /** Reshape a non-standard token response before it becomes a credential. */
  token?: (raw: TokenResponse) => TokenResponse;
};

const client = <C extends OAuth2Config>(ctx: Ctx<C>, spec: OAuth2Spec<C>): Client => ({
  clientId: ctx.config.clientId,
  redirectUri: ctx.redirectUri,
  ...(ctx.config.clientSecret !== undefined ? { clientSecret: ctx.config.clientSecret } : {}),
  ...(spec.clientAuth ? { auth: spec.clientAuth } : {}),
});

/** The standard authorization code steps, before any reshaping: what `oauth2()` and the flow builder's overrides (`next`) build on. */
export function oauth2Steps<C extends OAuth2Config>(spec: OAuth2Spec<C>) {
  return {
    start: (async (ctx, input) => {
      const p = spec.pkce === false ? null : await pkce();
      const scope = input.scope ?? (ctx.config.scopes ?? spec.scopes)?.join(spec.scopeSeparator ?? " ");
      const params = {
        ...(typeof spec.params === "function" ? spec.params(ctx.config) : spec.params),
        ...(scope ? { scope } : {}),
        ...(p ? { code_challenge: p.challenge, code_challenge_method: p.method } : {}),
      };
      return {
        data: p ? { verifier: p.verifier } : null,
        redirect: (state) => authorizeUrl(spec.authorizeUrl, client(ctx, spec), { ...params, state }),
      };
    }) satisfies Auth<C>["start"],

    /** The callback's code for tokens. */
    async exchange(ctx: Ctx<C>, params: Record<string, string>, data: Json): Promise<TokenResponse> {
      if (params.error) throw new OAuthError(params.error, 400, params);
      if (!params.code) throw new OAuthError("missing_code", 400, params);
      const verifier = (data as { verifier: string } | null)?.verifier;
      return exchangeCode(ctx.fetch, spec.tokenUrl, client(ctx, spec), params.code, verifier);
    },

    /** The refresh grant, provider error codes as they came. */
    grant: (ctx: Ctx<C>, cred: OAuth2): Promise<TokenResponse> => refreshGrant(ctx.fetch, spec.tokenUrl, client(ctx, spec), cred.refreshToken as string),

    /** RFC 7009 at `revokeUrl`; nothing without one. */
    async revoke(ctx: Ctx<C>, cred: Credential): Promise<void> {
      if (cred.kind !== "oauth2" || !spec.revokeUrl) return;
      await revoke(ctx.fetch, spec.revokeUrl, client(ctx, spec), cred.refreshToken ?? cred.accessToken, cred.refreshToken ? "refresh_token" : "access_token");
    },
  };
}

/** A provider's codes for a dead refresh token, as the `invalid_grant` the lifecycle acts on. */
export async function deadAs<T>(codes: string[] | undefined, run: Promise<T>): Promise<T> {
  try {
    return await run;
  } catch (e) {
    if (e instanceof OAuthError && codes?.includes(e.code)) throw new OAuthError("invalid_grant", e.status, e.body);
    throw e;
  }
}

/** Authorization code (+ PKCE). Scopes: `input.scope`, else `config.scopes`, else `spec.scopes`. */
export function oauth2<C extends OAuth2Config>(spec: OAuth2Spec<C>): Auth<C> {
  const shape = spec.token ?? ((t: TokenResponse) => t);
  const s = oauth2Steps(spec);
  return {
    start: s.start,
    callback: async (ctx, params, data) => credentialFrom(shape(await s.exchange(ctx, params, data)), ctx.now()),
    refresh: async (ctx, cred) => shape(await deadAs(spec.invalidGrant, s.grant(ctx, cred))),
    ...(spec.revokeUrl ? { revoke: s.revoke } : {}),
  };
}

/** Static credential from user input: API keys, basic auth. Check it against the provider in `metadata`. */
export const apiKey = <C = unknown>(fields: string[]): Auth<C> => ({
  fields,
  async start(_ctx, input) {
    const missing = fields.filter((f) => !input[f]);
    if (missing.length) throw new InputError(`missing ${missing.join(", ")}`);
    return { credential: { kind: "static", fields: Object.fromEntries(fields.map((f) => [f, input[f] as string])) } };
  },
});
