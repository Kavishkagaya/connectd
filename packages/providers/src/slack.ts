import { connection, hmacHex, type Json, type OAuth2, type OAuth2Config, rateHeaders, safeEqual, type TokenResponse } from "@kavishkagaya/connectd-connections";

/** `signingSecret` (app settings, Basic Information) verifies Events API requests (#25). */
export type SlackConfig = OAuth2Config & { userScopes?: string[]; signingSecret?: string };

/** Slack refuses requests older than this, against replays. */
const TOLERANCE_SEC = 300;

/** With user scopes only, the user token (nested under `authed_user`) is lifted up. */
const lift = (t: TokenResponse): TokenResponse => (typeof t.access_token === "string" ? t : { ...t, ...(t.authed_user as TokenResponse | undefined) });

/**
 * Slack OAuth v2. Bot scopes go in `scope`, user scopes in `user_scope`, both comma-separated.
 * The credential is the bot token; with user scopes only, the user token (nested under
 * `authed_user`) is lifted up. Token rotation (refresh_token + expires_in) is opt-in per app.
 * Errors are `{ ok: false, error }` with a 200.
 */
export const slack = connection("slack")
  .config<SlackConfig>((env) => {
    const signingSecret = env.optional("SLACK_SIGNING_SECRET");
    return { clientId: env("SLACK_CLIENT_ID"), clientSecret: env("SLACK_CLIENT_SECRET"), ...(signingSecret ? { signingSecret } : {}) };
  })
  .auth((f) =>
    f
      .oauth2({ authorizeUrl: "https://slack.com/oauth/v2/authorize", tokenUrl: "https://slack.com/api/oauth.v2.access" })
      .scopeSeparator(",")
      // ponytail: PKCE off; Slack's docs don't cover it for confidential clients. Turn on once confirmed.
      .pkce(false)
      .params((c): Record<string, string> => (c.userScopes?.length ? { user_scope: c.userScopes.join(",") } : {}))
      .callback(async (_ctx, params, next) => lift(await next(params)))
      .refresh(async (_ctx, cred, next) => lift(await next(cred)))
      .revoke(async (ctx, cred) => {
        if (cred.kind !== "oauth2") return;
        const res = await ctx.fetch("https://slack.com/api/auth.revoke", { method: "POST", headers: { authorization: `Bearer ${cred.accessToken}` } });
        const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (!body?.ok && body?.error !== "invalid_auth" && body?.error !== "token_revoked") throw new Error(`slack revoke ${body?.error ?? res.status}`);
      }),
  )
  .api({ baseUrl: "https://slack.com/api" })
  // ponytail: Slack limits per method per workspace (tiers 1-4); one Tier 3 budget for all methods until the proxy knows methods.
  .limit({ connection: { count: 50, periodMs: 60_000 } })
  .observe((res, now) => rateHeaders(res, now))
  /**
   * Events API: one Request URL per app (`/webhooks/slack`), set in the app's settings, so nothing
   * to register per connection. Signed v0 with the app's signing secret; routed by `team_id` to
   * every connection of that workspace.
   */
  // ponytail: Events API JSON only; interactivity and slash commands (form bodies) and Enterprise Grid org-wide installs (`authorizations[]`) come later.
  .webhooks({
    async verify(ctx, req) {
      if (!ctx.config.signingSecret) return false;
      const ts = req.headers.get("x-slack-request-timestamp") ?? "";
      if (!/^\d+$/.test(ts) || Math.abs(ctx.now() / 1000 - Number(ts)) > TOLERANCE_SEC) return false;
      return safeEqual(req.headers.get("x-slack-signature") ?? "", `v0=${await hmacHex(ctx.config.signingSecret, `v0:${ts}:${req.body}`)}`);
    },
    parse(req) {
      const b = JSON.parse(req.body) as { type?: string; challenge?: string; team_id?: string; event_id?: string; event?: { type?: string } };
      if (b.type === "url_verification") return { reply: { challenge: b.challenge ?? "" } };
      // The signing secret is app-wide, so the team is the only thing tying a delivery to a
      // connection (checked against it on /webhooks/slack/:id too): refuse one without it.
      if (!b.team_id) throw new Error("no team_id");
      return {
        topic: b.event?.type ?? b.type ?? "unknown",
        payload: b as Json,
        external: { key: "teamId", value: b.team_id },
        ...(b.event_id ? { delivery: b.event_id } : {}),
      };
    },
  })
  // The workspace is the external id webhooks route by (#25, #26); it's in the token response, no extra call.
  .identity(async (_ctx, cred) => {
    const raw = (cred as OAuth2).raw as { team?: { id: string; name: string }; authed_user?: { id: string }; bot_user_id?: string };
    if (!raw.team) throw new Error("slack: no team in token response");
    return { teamId: raw.team.id, teamName: raw.team.name, userId: raw.authed_user?.id ?? null, botUserId: raw.bot_user_id ?? null };
  })
  .external((m) => ({ teamId: m.teamId }));
