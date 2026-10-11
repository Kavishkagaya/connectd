import {
  authorizeUrl,
  type Client,
  credentialFrom,
  exchangeCode,
  OAuthError,
  pkce,
  refreshGrant,
  revoke,
  type TokenResponse,
} from "@openconnect/kernel";
import { type Auth, type Ctx, InputError } from "./define.ts";

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

/** Authorization code (+ PKCE). Scopes: `input.scope`, else `config.scopes`, else `spec.scopes`. */
export function oauth2<C extends OAuth2Config>(spec: OAuth2Spec<C>): Auth<C> {
  const shape = spec.token ?? ((t: TokenResponse) => t);
  return {
    async start(ctx, input) {
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
    },

    async callback(ctx, params, data) {
      if (params.error) throw new OAuthError(params.error, 400, params);
      if (!params.code) throw new OAuthError("missing_code", 400, params);
      const verifier = (data as { verifier: string } | null)?.verifier;
      return credentialFrom(shape(await exchangeCode(ctx.fetch, spec.tokenUrl, client(ctx, spec), params.code, verifier)), ctx.now());
    },

    async refresh(ctx, cred) {
      try {
        return shape(await refreshGrant(ctx.fetch, spec.tokenUrl, client(ctx, spec), cred.refreshToken as string));
      } catch (e) {
        if (e instanceof OAuthError && spec.invalidGrant?.includes(e.code)) throw new OAuthError("invalid_grant", e.status, e.body);
        throw e;
      }
    },

    ...(spec.revokeUrl
      ? {
          async revoke(ctx, cred) {
            if (cred.kind !== "oauth2") return;
            const url = spec.revokeUrl as string;
            await revoke(ctx.fetch, url, client(ctx, spec), cred.refreshToken ?? cred.accessToken, cred.refreshToken ? "refresh_token" : "access_token");
          },
        }
      : {}),
  };
}

/** Static credential from user input: API keys, basic auth. Check it against the provider in `metadata`. */
export const apiKey = <C = unknown>(fields: string[]): Auth<C> => ({
  async start(_ctx, input) {
    const missing = fields.filter((f) => !input[f]);
    if (missing.length) throw new InputError(`missing ${missing.join(", ")}`);
    return { credential: { kind: "static", fields: Object.fromEntries(fields.map((f) => [f, input[f] as string])) } };
  },
});
