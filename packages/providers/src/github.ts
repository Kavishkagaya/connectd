import { connection, hmacHex, type OAuth2Config, rateHeaders, safeEqual } from "@openconnect/connections";
import type { Json } from "@openconnect/kernel";

const API = "https://api.github.com";
// The REST API rejects requests without a User-Agent.
const headers = (auth: string) => ({ authorization: auth, accept: "application/vnd.github+json", "user-agent": "openconnect" });

/**
 * GitHub OAuth Apps (tokens don't expire) and GitHub Apps (8h access token, rotating refresh token).
 * Quirks: errors come with a 200, a dead refresh token is `bad_refresh_token`, revocation is
 * `DELETE /applications/{client_id}/grant` rather than RFC 7009.
 */
export const github = connection("github")
  .config<OAuth2Config>()
  .auth((f) =>
    f
      .oauth2({ authorizeUrl: "https://github.com/login/oauth/authorize", tokenUrl: "https://github.com/login/oauth/access_token" })
      .scopes("read:user")
      .deadRefreshToken("bad_refresh_token")
      .revoke(async (ctx, cred) => {
        if (cred.kind !== "oauth2") return;
        const res = await ctx.fetch(`${API}/applications/${ctx.config.clientId}/grant`, {
          method: "DELETE",
          headers: { ...headers(`Basic ${btoa(`${ctx.config.clientId}:${ctx.config.clientSecret ?? ""}`)}`), "content-type": "application/json" },
          body: JSON.stringify({ access_token: cred.accessToken }),
        });
        if (!res.ok && res.status !== 404) throw new Error(`github revoke ${res.status}`);
      }),
  )
  .api({ baseUrl: API, headers: { "user-agent": "openconnect" } })
  .limit({ connection: { count: 5000, periodMs: 3_600_000 } })
  .observe((res, now) => rateHeaders(res, now, { remaining: "x-ratelimit-remaining", reset: "x-ratelimit-reset" }))
  /**
   * Repo and org hooks (`X-Hub-Signature-256`), on the per-connection route with the connection's
   * own secret. Not auto-registered: GitHub has no account-wide hooks, so which repos or orgs to
   * hook is the app's call. It creates them through the proxy (`POST /repos/{o}/{r}/hooks`,
   * `content_type: "json"`) with the URL and secret from `webhooks.endpoint`.
   */
  // ponytail: no app-level route; GitHub App webhooks route by installation id, which the index doesn't hold yet.
  .webhooks({
    async verify(_ctx, req, secret) {
      return secret !== null && safeEqual(req.headers.get("x-hub-signature-256") ?? "", `sha256=${await hmacHex(secret, req.body)}`);
    },
    parse(req) {
      const topic = req.headers.get("x-github-event") ?? "";
      if (topic === "ping") return { reply: null };
      const delivery = req.headers.get("x-github-delivery");
      return { topic, payload: JSON.parse(req.body) as Json, ...(delivery ? { delivery } : {}) };
    },
  })
  .identity(async ({ api }) => {
    const u = await api.get<{ id: number; login: string }>("/user");
    return { id: String(u.id), login: u.login };
  })
  .external((me) => ({ id: me.id }));
