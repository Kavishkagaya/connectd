import {
  type AuthAttempt,
  type ConnectorConfig,
  decrypt,
  encrypt,
  type Grant,
  isProviderName,
  PROVIDERS,
  signState,
} from "@openconnect/shared";
import {
  updateConnectionStatus,
  upsertConnectionIndex,
} from "../connection-index";
import type { Env } from "../env";
import {
  CURRENT_KEY_VERSION,
  loadMasterKeys,
  loadStateSigningKey,
} from "../keys";
import {
  buildAuthorizeUrl,
  challengeFromVerifier,
  exchangeCode,
  generateCodeVerifier,
  refreshAccessToken,
  revokeToken,
  type TokenResponse,
} from "../oauth";

type Identity = { team: string; provider: string; tenant: string };

const MS_PER_SECOND = 1000;
const DEFAULT_TOKEN_TTL_SECONDS = 3600; // fallback when a provider omits expires_in
const ATTEMPT_TTL_MINUTES = 10; // time allowed to complete the OAuth dance
const ATTEMPT_TTL_MS = ATTEMPT_TTL_MINUTES * 60 * MS_PER_SECOND;
const REFRESH_BUFFER_MINUTES = 5; // refresh this long before the token actually expires
const REFRESH_BUFFER_MS = REFRESH_BUFFER_MINUTES * 60 * MS_PER_SECOND;
const MIN_ALARM_DELAY_SECONDS = 30; // never schedule an alarm sooner than this
const MIN_ALARM_DELAY_MS = MIN_ALARM_DELAY_SECONDS * MS_PER_SECOND;
const SCOPE_SPLIT_REGEX = /[ ,]/;

function expiresAtFromTokenResponse(tokenResponse: TokenResponse): number {
  const ttlSeconds = tokenResponse.expires_in ?? DEFAULT_TOKEN_TTL_SECONDS;
  return Date.now() + ttlSeconds * MS_PER_SECOND;
}

/**
 * One Connection DO per (team, provider, tenant), idFromName(`${team}:${provider}:${tenant}`).
 * Owns the full lifecycle for this single grant: the in-flight authorize attempt,
 * the token exchange, proactive refresh via alarm(), and revocation.
 */
export class ConnectionDO {
  private readonly state: DurableObjectState;
  private readonly env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      switch (`${request.method} ${url.pathname}`) {
        case "POST /start":
          return await this.start(await request.json());
        case "POST /callback":
          return await this.callback(await request.json());
        case "GET /token":
          return await this.getToken();
        case "POST /revoke":
          return await this.revoke();
        default:
          return new Response("not found", { status: 404 });
      }
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "unknown error" },
        { status: 400 }
      );
    }
  }

  async alarm(): Promise<void> {
    const identity = await this.state.storage.get<Identity>("identity");
    const grant = await this.loadGrant();
    if (!(identity && grant?.refreshToken)) {
      return;
    }
    const provider = PROVIDERS[identity.provider as keyof typeof PROVIDERS];
    const connector = await this.fetchConnectorConfig(identity);

    try {
      const tokenResponse = await refreshAccessToken(
        provider,
        connector,
        grant.refreshToken
      );
      const expiresAt = expiresAtFromTokenResponse(tokenResponse);
      await this.storeGrant(identity, {
        ...grant,
        accessToken: tokenResponse.access_token,
        refreshToken: tokenResponse.refresh_token ?? grant.refreshToken,
        expiresAt,
        status: "active",
      });
      await this.scheduleRefresh(expiresAt);
    } catch {
      // ponytail: single attempt, no retry/backoff loop yet — add if refresh failures show up in practice.
      await this.storeGrant(identity, { ...grant, status: "needs_reauth" });
      await updateConnectionStatus(
        this.env,
        this.doName(identity),
        "needs_reauth"
      );
    }
  }

  private async start(body: {
    team: string;
    provider: string;
    tenant: string;
    scopes: string[];
  }): Promise<Response> {
    if (!isProviderName(body.provider)) {
      return Response.json({ error: "unknown provider" }, { status: 400 });
    }
    const identity: Identity = {
      team: body.team,
      provider: body.provider,
      tenant: body.tenant,
    };
    await this.state.storage.put("identity", identity);

    const connector = await this.fetchConnectorConfig(identity);
    const provider = PROVIDERS[body.provider];
    const codeVerifier = generateCodeVerifier();
    const signingKey = await loadStateSigningKey(this.env);
    const state = await signState(this.doName(identity), signingKey);

    const attempt: AuthAttempt = {
      state,
      codeVerifier,
      requestedScopes: body.scopes,
      expiresAt: Date.now() + ATTEMPT_TTL_MS,
    };
    await this.state.storage.put("attempt", attempt);

    const authorizeUrl = buildAuthorizeUrl(provider, connector, {
      state,
      codeChallenge: await challengeFromVerifier(codeVerifier),
      scopes: body.scopes,
    });
    return Response.json({ authorizeUrl });
  }

  private async callback(body: {
    code: string;
    state: string;
  }): Promise<Response> {
    const identity = await this.state.storage.get<Identity>("identity");
    const attempt = await this.state.storage.get<AuthAttempt>("attempt");
    if (!(identity && attempt) || attempt.state !== body.state) {
      return Response.json({ error: "no matching attempt" }, { status: 400 });
    }
    if (Date.now() > attempt.expiresAt) {
      await this.state.storage.delete("attempt");
      return Response.json({ error: "attempt expired" }, { status: 400 });
    }

    const provider = PROVIDERS[identity.provider as keyof typeof PROVIDERS];
    const connector = await this.fetchConnectorConfig(identity);
    const tokenResponse = await exchangeCode(provider, connector, {
      code: body.code,
      codeVerifier: attempt.codeVerifier,
    });

    const expiresAt = expiresAtFromTokenResponse(tokenResponse);
    const grant: Grant = {
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token,
      expiresAt,
      grantedScopes: (
        tokenResponse.scope ?? attempt.requestedScopes.join(" ")
      ).split(SCOPE_SPLIT_REGEX),
      tokenType: "Bearer",
      status: "active",
    };
    await this.storeGrant(identity, grant);
    await this.state.storage.delete("attempt");
    if (grant.refreshToken) {
      await this.scheduleRefresh(expiresAt);
    }
    await upsertConnectionIndex(this.env, {
      doName: this.doName(identity),
      teamId: identity.team,
      provider: identity.provider,
      tenantId: identity.tenant,
      status: "active",
      scopes: grant.grantedScopes,
    });

    return Response.json({ ok: true, expiresAt, scopes: grant.grantedScopes });
  }

  private async getToken(): Promise<Response> {
    const identity = await this.state.storage.get<Identity>("identity");
    let grant = await this.loadGrant();
    if (!(identity && grant) || grant.status !== "active") {
      return Response.json({ error: "not connected" }, { status: 404 });
    }

    if (
      grant.expiresAt < Date.now() + REFRESH_BUFFER_MS &&
      grant.refreshToken
    ) {
      await this.alarm(); // refresh inline in case the scheduled alarm hasn't fired yet
      grant = await this.loadGrant();
      if (!grant || grant.status !== "active") {
        return Response.json({ error: "reauth required" }, { status: 409 });
      }
    }

    return Response.json({
      accessToken: grant.accessToken,
      expiresAt: grant.expiresAt,
    });
  }

  private async revoke(): Promise<Response> {
    const identity = await this.state.storage.get<Identity>("identity");
    const grant = await this.loadGrant();
    if (identity && grant) {
      const provider = PROVIDERS[identity.provider as keyof typeof PROVIDERS];
      const connector = await this.fetchConnectorConfig(identity);
      await revokeToken(provider, connector, grant.accessToken).catch(() => {
        // ponytail: best-effort — the grant is deleted locally regardless of provider response.
      });
      await updateConnectionStatus(this.env, this.doName(identity), "revoked");
    }
    await this.state.storage.deleteAll();
    return Response.json({ ok: true });
  }

  private async fetchConnectorConfig(
    identity: Identity
  ): Promise<ConnectorConfig> {
    const teamDoId = this.env.TEAM_DO.idFromName(identity.team);
    const response = await this.env.TEAM_DO.get(teamDoId).fetch(
      `https://team-do/${identity.provider}`
    );
    if (!response.ok) {
      throw new Error(`no connector configured for ${identity.provider}`);
    }
    return response.json();
  }

  private async loadGrant(): Promise<Grant | null> {
    const encrypted = await this.state.storage.get<string>("grant");
    if (!encrypted) {
      return null;
    }
    const { byVersion } = await loadMasterKeys(this.env);
    return JSON.parse(await decrypt(encrypted, byVersion));
  }

  private async storeGrant(identity: Identity, grant: Grant): Promise<void> {
    const { current } = await loadMasterKeys(this.env);
    const encrypted = await encrypt(
      JSON.stringify(grant),
      current,
      CURRENT_KEY_VERSION
    );
    await this.state.storage.put("grant", encrypted);
    if (grant.status !== "active") {
      await updateConnectionStatus(
        this.env,
        this.doName(identity),
        grant.status
      );
    }
  }

  private async scheduleRefresh(expiresAt: number): Promise<void> {
    await this.state.storage.setAlarm(
      Math.max(expiresAt - REFRESH_BUFFER_MS, Date.now() + MIN_ALARM_DELAY_MS)
    );
  }

  private doName(identity: Identity): string {
    return `${identity.team}:${identity.provider}:${identity.tenant}`;
  }
}
