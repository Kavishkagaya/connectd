import { connection, type Credential, type OAuth2, type OAuth2Config, rateHeaders, safeEqual } from "@openconnect/connections";
import { fromBase64url } from "@openconnect/kernel";

/**
 * `watchCalendar` registers a push channel on each connection's primary calendar (#25); the app
 * adds a calendar scope (`.../auth/calendar.readonly`) to `scopes` with it.
 */
export type GoogleConfig = OAuth2Config & { watchCalendar?: boolean };

const CALENDAR = "https://www.googleapis.com/calendar/v3";
const bearer = (cred: Credential) => ({ authorization: `Bearer ${(cred as OAuth2).accessToken}`, "content-type": "application/json" });

/**
 * Google. `access_type=offline` + `prompt=consent` so every authorization (re-auth included) returns
 * a refresh token. Refresh tokens don't rotate. Who it is comes from the id_token, which arrives
 * straight from the token endpoint over TLS, so it's read without verifying the signature (OIDC 3.1.3.7).
 */
export const google = connection("google")
  .config<GoogleConfig>((env) => ({ clientId: env("GOOGLE_CLIENT_ID"), clientSecret: env("GOOGLE_CLIENT_SECRET") }))
  .auth((f) =>
    f
      .oauth2({
        authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        revokeUrl: "https://oauth2.googleapis.com/revoke",
      })
      .scopes("openid", "email", "profile")
      .params({ access_type: "offline", prompt: "consent", include_granted_scopes: "true" }),
  )
  // ponytail: one host; APIs only on their own host (gmail.googleapis.com, sheets.googleapis.com) need a host-per-request proxy.
  .api({ baseUrl: "https://www.googleapis.com" })
  // Quotas are per API and per project; only follow what Google says.
  .observe((res, now) => rateHeaders(res, now))
  /**
   * Push notifications (Calendar `events.watch`): a channel per connection, created when it goes
   * active, renewed before it lapses (Google caps channel lifetime), stopped before revoke. Google
   * signs nothing; the channel token is the connection's webhook secret, echoed in a header. The
   * body is empty: the event says what changed, the app re-reads it (sync token) through the proxy.
   */
  // ponytail: Calendar only; Drive `changes.watch` has the same shape, Gmail needs Pub/Sub (app-level, OIDC-signed).
  .webhooks({
    verify: async (_ctx, req, secret) => secret !== null && safeEqual(req.headers.get("x-goog-channel-token") ?? "", secret),
    parse(req) {
      const h = (n: string) => req.headers.get(`x-goog-${n}`);
      // `sync` is the channel's hello, sent once at creation.
      if (h("resource-state") === "sync") return { reply: null };
      return {
        topic: `calendar.${h("resource-state") ?? "unknown"}`,
        delivery: `${h("channel-id")}:${h("message-number")}`,
        payload: { channelId: h("channel-id"), resourceId: h("resource-id"), resourceUri: h("resource-uri"), messageNumber: h("message-number") },
      };
    },
    async register(ctx, cred, { url, secret }) {
      if (!ctx.config.watchCalendar) return null;
      const res = await ctx.fetch(`${CALENDAR}/calendars/primary/events/watch`, {
        method: "POST",
        headers: bearer(cred),
        body: JSON.stringify({ id: crypto.randomUUID(), type: "web_hook", address: url, token: secret }),
      });
      if (!res.ok) throw new Error(`google events.watch ${res.status}`);
      const ch = (await res.json()) as { id: string; resourceId: string; expiration?: string };
      return { hook: { id: ch.id, resourceId: ch.resourceId }, ...(ch.expiration ? { expiresAt: Number(ch.expiration) } : {}) };
    },
    async unregister(ctx, cred, hook) {
      const res = await ctx.fetch(`${CALENDAR}/channels/stop`, { method: "POST", headers: bearer(cred), body: JSON.stringify(hook) });
      // 404: already gone (lapsed).
      if (!res.ok && res.status !== 404) throw new Error(`google channels.stop ${res.status}`);
    },
  })
  .identity(async (_ctx, cred) => {
    const idToken = (cred as OAuth2).raw.id_token;
    if (typeof idToken !== "string") throw new Error("google: no id_token; keep the openid scope");
    const claims = JSON.parse(new TextDecoder().decode(fromBase64url(idToken.split(".")[1] ?? ""))) as { sub: string; email?: string };
    return { sub: claims.sub, email: claims.email ?? null };
  })
  .external((m) => ({ sub: m.sub }));
