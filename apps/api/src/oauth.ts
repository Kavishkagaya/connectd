import {
  base64url,
  type ConnectorConfig,
  type ProviderConfig,
} from "@openconnect/shared";

const CODE_VERIFIER_BYTES = 32;

export function generateCodeVerifier(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(CODE_VERIFIER_BYTES)));
}

export async function challengeFromVerifier(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier)
  );
  return base64url(new Uint8Array(digest));
}

export function buildAuthorizeUrl(
  provider: ProviderConfig,
  connector: ConnectorConfig,
  opts: { state: string; codeChallenge: string; scopes: string[] }
): string {
  const url = new URL(provider.authorizationEndpoint);
  url.searchParams.set("client_id", connector.clientId);
  url.searchParams.set("redirect_uri", connector.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", opts.state);
  url.searchParams.set("scope", opts.scopes.join(provider.scopeSeparator));
  if (provider.pkceRequired) {
    url.searchParams.set("code_challenge", opts.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.toString();
}

export type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
};

function tokenRequestHeaders(
  provider: ProviderConfig,
  connector: ConnectorConfig
): HeadersInit {
  const headers: HeadersInit = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };
  if (provider.tokenEndpointAuthMethod === "client_secret_basic") {
    headers.authorization = `Basic ${btoa(`${connector.clientId}:${connector.clientSecret}`)}`;
  }
  return headers;
}

function tokenRequestBody(
  provider: ProviderConfig,
  connector: ConnectorConfig,
  params: Record<string, string>
): URLSearchParams {
  const body = new URLSearchParams(params);
  if (provider.tokenEndpointAuthMethod === "client_secret_post") {
    body.set("client_id", connector.clientId);
    body.set("client_secret", connector.clientSecret);
  }
  return body;
}

async function postToken(
  provider: ProviderConfig,
  connector: ConnectorConfig,
  params: Record<string, string>
): Promise<TokenResponse> {
  const response = await fetch(provider.tokenEndpoint, {
    method: "POST",
    headers: tokenRequestHeaders(provider, connector),
    body: tokenRequestBody(provider, connector, params),
  });
  if (!response.ok) {
    throw new Error(`token endpoint returned ${response.status}`);
  }
  return response.json();
}

export function exchangeCode(
  provider: ProviderConfig,
  connector: ConnectorConfig,
  opts: { code: string; codeVerifier: string }
): Promise<TokenResponse> {
  return postToken(provider, connector, {
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: connector.redirectUri,
    code_verifier: opts.codeVerifier,
  });
}

export function refreshAccessToken(
  provider: ProviderConfig,
  connector: ConnectorConfig,
  refreshToken: string
): Promise<TokenResponse> {
  return postToken(provider, connector, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}

export async function revokeToken(
  provider: ProviderConfig,
  connector: ConnectorConfig,
  token: string
): Promise<void> {
  if (!provider.revocationEndpoint) {
    return; // ponytail: not every provider exposes one; caller still marks the grant revoked locally.
  }
  await fetch(provider.revocationEndpoint, {
    method: "POST",
    headers: tokenRequestHeaders(provider, connector),
    body: tokenRequestBody(provider, connector, { token }),
  });
}
