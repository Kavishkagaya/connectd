import {
  connection,
  credentialFrom,
  exchangeCode,
  hmacHex,
  type OAuth2,
  type OAuth2Config,
  OAuthError,
  rateHeaders,
  safeEqual,
  signingKey,
  signJwt,
  type TokenResponse,
} from "@openconnect/connections";
import type { Json } from "@openconnect/kernel";

const API = "https://api.github.com";
const headers = (auth: string) => ({ authorization: auth, accept: "application/vnd.github+json", "user-agent": "openconnect" });

/**
 * `appId`, `slug` (the app's URL name) and `privateKey` (the PEM GitHub generates) from the app's
 * settings. `clientId`/`clientSecret` too: "Request user authorization (OAuth) during installation"
 * must be on, so the callback can check who installed it (their account, or an org they're an admin
 * of; the app needs the "Members: read" organization permission for the org check). The
 * webhook secret is the app's (one URL for the app: `/webhooks/github-app`).
 */
export type GitHubAppConfig = OAuth2Config & { appId: string; slug: string; privateKey: string; webhookSecret?: string };

type Data = { installationId: number; account: string };

/** The app's own JWT (10 min, backdated a minute for clock drift), which mints installation tokens. */
async function appJwt(c: GitHubAppConfig, now: number) {
  const iat = Math.floor(now / 1000) - 60;
  return signJwt({ iat, exp: iat + 600, iss: c.appId }, await signingKey(c.privateKey));
}

type Installation = { id: number; account: { login: string; id: number; type: string } };

/**
 * Whether the user behind `token` may connect installation `id`: it's on their own account, or on
 * an org they're an admin of. Seeing it (`/user/installations`) isn't enough: that lists every
 * installation with a repo the user can access, so any org member would get the bot's access.
 */
async function claimable(f: typeof fetch, token: string, id: number): Promise<Installation | null> {
  const get = async <T>(path: string) => {
    const res = await f(`${API}${path}`, { headers: headers(`Bearer ${token}`) });
    return res.ok ? ((await res.json()) as T) : null;
  };
  let found: Installation | undefined;
  for (let page = 1; !found; page++) {
    const r = await get<{ installations: Installation[] }>(`/user/installations?per_page=100&page=${page}`);
    if (!r) throw new Error("github /user/installations failed");
    found = r.installations.find((i) => i.id === id);
    if (r.installations.length < 100) break;
  }
  if (!found) return null;
  if (found.account.type === "User") return (await get<{ id: number }>("/user"))?.id === found.account.id ? found : null;
  // Fails closed: a 404 or 403 (not a member, or no access to memberships) is a no.
  const m = await get<{ role: string; state: string }>(`/user/memberships/orgs/${encodeURIComponent(found.account.login)}`);
  return m?.role === "admin" && m.state === "active" ? found : null;
}

/** The user token was only for the check above: revoke it (best effort). */
async function dropUserToken(ctx: { config: GitHubAppConfig; fetch: typeof fetch }, token: string) {
  const { clientId, clientSecret } = ctx.config;
  if (!clientSecret) return;
  await ctx
    .fetch(`${API}/applications/${encodeURIComponent(clientId)}/token`, {
      method: "DELETE",
      headers: { ...headers(`Basic ${btoa(`${clientId}:${clientSecret}`)}`), "content-type": "application/json" },
      body: JSON.stringify({ access_token: token }),
    })
    .catch((e) => console.error("github: revoking the installing user's token failed", e));
}

/** An installation token (1 h). Uninstalled or suspended: `invalid_grant`, so the connection needs a new install. */
async function mint(ctx: { config: GitHubAppConfig; fetch: typeof fetch; now(): number }, installationId: number): Promise<TokenResponse> {
  const res = await ctx.fetch(`${API}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: headers(`Bearer ${await appJwt(ctx.config, ctx.now())}`),
  });
  // 404: uninstalled; 403: suspended, unless it's a rate limit (try again later).
  const limited = res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after");
  if (res.status === 404 || (res.status === 403 && !limited)) throw new OAuthError("invalid_grant", res.status, null);
  if (!res.ok) throw new Error(`github installation token ${res.status}`);
  const b = (await res.json()) as { token: string; expires_at: string };
  return { access_token: b.token, expires_in: Math.floor((Date.parse(b.expires_at) - ctx.now()) / 1000) };
}

/**
 * GitHub Apps (#56): one connection per installation (an org or a user account), acting as the
 * app's bot there. Connect sends the user to install the app; the callback checks the installation
 * is the user's own or an org they administer (so a member can't claim their org's), then mints installation
 * tokens from the app's key, again on every expiry, with no refresh token.
 */
// ponytail: revoke is local only; uninstalling is the org admin's call (DELETE /app/installations/{id} would remove the app for everyone there).
export const githubApp = connection("github-app")
  .config<GitHubAppConfig>()
  .auth((f) =>
    f.flow({
      mints: true,
      async start(ctx) {
        return { data: null, redirect: (state) => `https://github.com/apps/${encodeURIComponent(ctx.config.slug)}/installations/new?state=${encodeURIComponent(state)}` };
      },
      async callback(ctx, params) {
        if (params.setup_action === "request") throw new OAuthError("installation_requested", 400, "an org owner has to approve the install");
        const id = Number(params.installation_id);
        if (!Number.isSafeInteger(id) || id <= 0) throw new OAuthError("missing_installation", 400, params);
        if (!params.code) throw new OAuthError("missing_code", 400, "turn on: Request user authorization (OAuth) during installation");
        const user = await exchangeCode(
          ctx.fetch,
          "https://github.com/login/oauth/access_token",
          { clientId: ctx.config.clientId, ...(ctx.config.clientSecret ? { clientSecret: ctx.config.clientSecret } : {}), redirectUri: ctx.redirectUri },
          params.code,
        );
        const token = user.access_token as string;
        const found = await claimable(ctx.fetch, token, id).finally(() => dropUserToken(ctx, token));
        if (!found) throw new OAuthError("access_denied", 403, "the installation isn't on the user's account or an org they administer");
        const data: Data = { installationId: id, account: found.account.login };
        return { ...credentialFrom(await mint(ctx, id), ctx.now()), data };
      },
      refresh: (ctx, cred) => mint(ctx, (cred.data as Data).installationId),
    }),
  )
  .api({ baseUrl: API, headers: { "user-agent": "openconnect" } })
  .limit({ connection: { count: 5000, periodMs: 3_600_000 } })
  .observe((res, now) => rateHeaders(res, now, { remaining: "x-ratelimit-remaining", reset: "x-ratelimit-reset" }))
  /** App webhooks: one URL for the app, signed with its webhook secret, routed by installation id. */
  .webhooks({
    async verify(ctx, req, secret) {
      const key = secret ?? ctx.config.webhookSecret;
      return !!key && safeEqual(req.headers.get("x-hub-signature-256") ?? "", `sha256=${await hmacHex(key, req.body)}`);
    },
    parse(req) {
      const topic = req.headers.get("x-github-event") ?? "";
      if (topic === "ping") return { reply: null };
      const b = JSON.parse(req.body) as { installation?: { id: number } };
      if (!b.installation) throw new Error("no installation");
      const delivery = req.headers.get("x-github-delivery");
      return { topic, payload: b as Json, external: { key: "installation", value: String(b.installation.id) }, ...(delivery ? { delivery } : {}) };
    },
  })
  .identity(async (_ctx, cred) => {
    const d = (cred as OAuth2).data as Data;
    return { installationId: String(d.installationId), account: d.account };
  })
  .external((me) => ({ installation: me.installationId }));
