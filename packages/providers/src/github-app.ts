import {
  connection,
  credentialFrom,
  exchangeCode,
  hmacHex,
  importPrivateKey,
  type OAuth2,
  type OAuth2Config,
  OAuthError,
  rateHeaders,
  safeEqual,
  signJwt,
  type TokenResponse,
} from "@openconnect/connections";
import type { Json } from "@openconnect/kernel";

const API = "https://api.github.com";
const headers = (auth: string) => ({ authorization: auth, accept: "application/vnd.github+json", "user-agent": "openconnect" });

/**
 * `appId`, `slug` (the app's URL name) and `privateKey` (the PEM GitHub generates) from the app's
 * settings. `clientId`/`clientSecret` too: "Request user authorization (OAuth) during installation"
 * must be on, so the callback can check the installing user can see the installation. The
 * webhook secret is the app's (one URL for the app: `/webhooks/github-app`).
 */
export type GitHubAppConfig = OAuth2Config & { appId: string; slug: string; privateKey: string; webhookSecret?: string };

type Data = { installationId: number; account: string };

const keys = new Map<string, Promise<CryptoKey>>();

/** The app's own JWT (10 min, backdated a minute for clock drift), which mints installation tokens. */
async function appJwt(c: GitHubAppConfig, now: number) {
  let key = keys.get(c.privateKey);
  if (!key) keys.set(c.privateKey, (key = importPrivateKey(c.privateKey)));
  const iat = Math.floor(now / 1000) - 60;
  return signJwt({ iat, exp: iat + 600, iss: c.appId }, await key);
}

/** An installation token (1 h). Uninstalled or suspended: `invalid_grant`, so the connection needs a new install. */
async function mint(ctx: { config: GitHubAppConfig; fetch: typeof fetch; now(): number }, installationId: number): Promise<TokenResponse> {
  const res = await ctx.fetch(`${API}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: headers(`Bearer ${await appJwt(ctx.config, ctx.now())}`),
  });
  if (res.status === 404 || res.status === 403) throw new OAuthError("invalid_grant", res.status, null);
  if (!res.ok) throw new Error(`github installation token ${res.status}`);
  const b = (await res.json()) as { token: string; expires_at: string };
  return { access_token: b.token, expires_in: Math.floor((Date.parse(b.expires_at) - ctx.now()) / 1000) };
}

/**
 * GitHub Apps (#56): one connection per installation (an org or a user account), acting as the
 * app's bot there. Connect sends the user to install the app; the callback checks the installing
 * user can see that installation (so nobody can claim another org's), then mints installation
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
        const res = await ctx.fetch(`${API}/user/installations`, { headers: headers(`Bearer ${user.access_token as string}`) });
        if (!res.ok) throw new Error(`github /user/installations ${res.status}`);
        const found = ((await res.json()) as { installations: { id: number; account: { login: string } }[] }).installations.find((i) => i.id === id);
        if (!found) throw new OAuthError("access_denied", 403, "the installing user can't see that installation");
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
