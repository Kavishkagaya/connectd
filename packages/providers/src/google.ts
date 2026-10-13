import { defineConnection, type OAuth2Config, oauth2, rateHeaders } from "@openconnect/connections";
import { fromBase64url, type OAuth2 } from "@openconnect/kernel";

/**
 * Google. `access_type=offline` + `prompt=consent` so every authorization (re-auth included) returns
 * a refresh token. Refresh tokens don't rotate. Who it is comes from the id_token, which arrives
 * straight from the token endpoint over TLS, so it's read without verifying the signature (OIDC 3.1.3.7).
 */
export const google = defineConnection({
  id: "google",
  auth: oauth2<OAuth2Config>({
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    revokeUrl: "https://oauth2.googleapis.com/revoke",
    scopes: ["openid", "email", "profile"],
    params: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
  }),
  async metadata(_ctx, cred) {
    const idToken = (cred as OAuth2).raw.id_token;
    if (typeof idToken !== "string") throw new Error("google: no id_token; keep the openid scope");
    const claims = JSON.parse(new TextDecoder().decode(fromBase64url(idToken.split(".")[1] ?? ""))) as { sub: string; email?: string };
    return { sub: claims.sub, email: claims.email ?? null };
  },
  external: (m) => ({ sub: m.sub }),
  // ponytail: one host; APIs only on their own host (gmail.googleapis.com, sheets.googleapis.com) need a host-per-request proxy.
  proxy: { baseUrl: "https://www.googleapis.com" },
  // Quotas are per API and per project; only follow what Google says.
  rate: { observe: (res, now) => rateHeaders(res, now) },
});
