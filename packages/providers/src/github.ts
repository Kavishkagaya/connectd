import { defineConnection, type OAuth2Config, oauth2, rateHeaders } from "@openconnect/connections";
import type { OAuth2 } from "@openconnect/kernel";

const API = "https://api.github.com";
// The REST API rejects requests without a User-Agent.
const headers = (auth: string) => ({ authorization: auth, accept: "application/vnd.github+json", "user-agent": "openconnect" });

/**
 * GitHub OAuth Apps (tokens don't expire) and GitHub Apps (8h access token, rotating refresh token).
 * Quirks: errors come with a 200, a dead refresh token is `bad_refresh_token`, revocation is
 * `DELETE /applications/{client_id}/grant` rather than RFC 7009.
 */
export const github = defineConnection({
  id: "github",
  auth: {
    ...oauth2<OAuth2Config>({
      authorizeUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      scopes: ["read:user"],
      invalidGrant: ["bad_refresh_token"],
    }),
    async revoke(ctx, cred) {
      if (cred.kind !== "oauth2") return;
      const res = await ctx.fetch(`${API}/applications/${ctx.config.clientId}/grant`, {
        method: "DELETE",
        headers: { ...headers(`Basic ${btoa(`${ctx.config.clientId}:${ctx.config.clientSecret ?? ""}`)}`), "content-type": "application/json" },
        body: JSON.stringify({ access_token: cred.accessToken }),
      });
      if (!res.ok && res.status !== 404) throw new Error(`github revoke ${res.status}`);
    },
  },
  async metadata(ctx, cred) {
    const res = await ctx.fetch(`${API}/user`, { headers: headers(`Bearer ${(cred as OAuth2).accessToken}`) });
    if (!res.ok) throw new Error(`github /user ${res.status}`);
    const u = (await res.json()) as { id: number; login: string };
    return { id: String(u.id), login: u.login };
  },
  rate: {
    connection: { count: 5000, periodMs: 3_600_000 },
    observe: (res, now) => rateHeaders(res, now, { remaining: "x-ratelimit-remaining", reset: "x-ratelimit-reset" }),
  },
});
