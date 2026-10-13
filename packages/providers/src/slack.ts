import { defineConnection, type OAuth2Config, oauth2, rateHeaders } from "@openconnect/connections";
import type { OAuth2, TokenResponse } from "@openconnect/kernel";

export type SlackConfig = OAuth2Config & { userScopes?: string[] };

/**
 * Slack OAuth v2. Bot scopes go in `scope`, user scopes in `user_scope`, both comma-separated.
 * The credential is the bot token; with user scopes only, the user token (nested under
 * `authed_user`) is lifted up. Token rotation (refresh_token + expires_in) is opt-in per app.
 * Errors are `{ ok: false, error }` with a 200.
 */
export const slack = defineConnection({
  id: "slack",
  auth: {
    ...oauth2<SlackConfig>({
      authorizeUrl: "https://slack.com/oauth/v2/authorize",
      tokenUrl: "https://slack.com/api/oauth.v2.access",
      scopeSeparator: ",",
      // ponytail: PKCE off; Slack's docs don't cover it for confidential clients. Turn on once confirmed.
      pkce: false,
      params: (c): Record<string, string> => (c.userScopes?.length ? { user_scope: c.userScopes.join(",") } : {}),
      token: (t) => (typeof t.access_token === "string" ? t : { ...t, ...(t.authed_user as TokenResponse | undefined) }),
    }),
    async revoke(ctx, cred) {
      if (cred.kind !== "oauth2") return;
      const res = await ctx.fetch("https://slack.com/api/auth.revoke", { method: "POST", headers: { authorization: `Bearer ${cred.accessToken}` } });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!body?.ok && body?.error !== "invalid_auth" && body?.error !== "token_revoked") throw new Error(`slack revoke ${body?.error ?? res.status}`);
    },
  },
  // The workspace is the external id webhooks route by (#25, #26); it's in the token response, no extra call.
  async metadata(_ctx, cred) {
    const raw = (cred as OAuth2).raw as { team?: { id: string; name: string }; authed_user?: { id: string }; bot_user_id?: string };
    if (!raw.team) throw new Error("slack: no team in token response");
    return { teamId: raw.team.id, teamName: raw.team.name, userId: raw.authed_user?.id ?? null, botUserId: raw.bot_user_id ?? null };
  },
  external: (m) => ({ teamId: m.teamId }),
  rate: {
    // ponytail: Slack limits per method per workspace (tiers 1-4); one Tier 3 budget for all methods until the proxy knows methods.
    connection: { count: 50, periodMs: 60_000 },
    observe: (res, now) => rateHeaders(res, now),
  },
});
