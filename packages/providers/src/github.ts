import { connection, type Credential, hmacHex, type OAuth2Config, rateHeaders, safeEqual, type StandardSchemaV1 } from "@connectd/connections";
import type { Json } from "@connectd/kernel";

const API = "https://api.github.com";
// The REST API rejects requests without a User-Agent.
const headers = (auth: string) => ({ authorization: auth, accept: "application/vnd.github+json", "user-agent": "connectd" });

/** A repo hook subscription: `owner/name`, and the events (default `["push"]`). */
export type RepoHook = { repo: string; events?: string[] };

// A Standard Schema by hand, so the provider depends on no validation library.
const repoHook: StandardSchemaV1<RepoHook> = {
  "~standard": {
    version: 1,
    vendor: "connectd",
    validate(v) {
      const o = (typeof v === "object" && v !== null ? v : {}) as { repo?: unknown; events?: unknown };
      // It goes into API URLs with the user's token: no `.` or `..` segments.
      const [owner, name, ...more] = typeof o.repo === "string" ? o.repo.split("/") : [];
      const part = (p: string | undefined, max: number) => !!p && p.length <= max && /^[\w.-]+$/.test(p) && p !== "." && p !== "..";
      if (more.length || !part(owner, 39) || !part(name, 100)) return { issues: [{ message: "owner/name", path: ["repo"] }] };
      if (o.events !== undefined && !(Array.isArray(o.events) && o.events.length && o.events.length <= 100 && o.events.every((e) => typeof e === "string" && /^[a-z_*]{1,64}$/.test(e))))
        return { issues: [{ message: "a non-empty list of event names", path: ["events"] }] };
      return { value: { repo: `${owner}/${name}`, ...(o.events ? { events: o.events as string[] } : {}) } };
    },
  },
};

const bearer = (cred: Credential) => headers(`Bearer ${cred.kind === "oauth2" ? cred.accessToken : ""}`);

/**
 * GitHub OAuth Apps (tokens don't expire) and GitHub Apps (8h access token, rotating refresh token).
 * Quirks: errors come with a 200, a dead refresh token is `bad_refresh_token`, revocation is
 * `DELETE /applications/{client_id}/grant` rather than RFC 7009.
 */
export const github = connection("github")
  .config<OAuth2Config>((env) => ({ clientId: env("GITHUB_CLIENT_ID"), clientSecret: env("GITHUB_CLIENT_SECRET") }))
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
  .api({ baseUrl: API, headers: { "user-agent": "connectd" } })
  .limit({ connection: { count: 5000, periodMs: 3_600_000 } })
  .observe((res, now) => rateHeaders(res, now, { remaining: "x-ratelimit-remaining", reset: "x-ratelimit-reset" }))
  .identity(async ({ api }) => {
    const res = await api.fetch("/user", { headers: { accept: "application/vnd.github+json" } });
    if (!res.ok) throw new Error(`github /user ${res.status}`);
    const u = (await res.json()) as { id: number; login: string };
    return { id: String(u.id), login: u.login };
  })
  .external((me) => ({ id: me.id }))
  /**
   * Repo hooks (`X-Hub-Signature-256`), on the per-connection route with the connection's own
   * secret. GitHub has no account-wide hooks, so the app subscribes per repo:
   * `webhooks.subscribe { repo: "o/r", events: ["push"] }` creates the hook (`admin:repo_hook` scope),
   * `webhooks.unsubscribe` deletes it. Org hooks: create them through the proxy with `webhooks.endpoint`.
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
    subscription: repoHook,
    async register(ctx, cred, { url, secret }, { repo, events = ["push"] }) {
      const res = await ctx.fetch(`${API}/repos/${repo}/hooks`, {
        method: "POST",
        headers: { ...bearer(cred), "content-type": "application/json" },
        body: JSON.stringify({ name: "web", active: true, events, config: { url, secret, content_type: "json" } }),
      });
      if (!res.ok) throw new Error(`github create hook on ${repo}: ${res.status}`);
      return { hook: { repo, id: ((await res.json()) as { id: number }).id } };
    },
    async unregister(ctx, cred, hook) {
      const { repo, id } = hook as { repo: string; id: number };
      const res = await ctx.fetch(`${API}/repos/${repo}/hooks/${id}`, { method: "DELETE", headers: bearer(cred) });
      if (!res.ok && res.status !== 404) throw new Error(`github delete hook ${res.status}`);
    },
  });
