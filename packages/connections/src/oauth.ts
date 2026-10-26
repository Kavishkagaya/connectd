import { base64url, type Json, randomId } from "@kavishkagaya/connectd-kernel";

/**
 * OAuth protocol atoms: RFC 6749 + PKCE (7636), device code (8628), DCR (7591), revocation (7009).
 * Provider-agnostic; quirks live in the caller. `fetchFn` is passed in so tests and proxies can swap it.
 */

export type Client = { clientId: string; clientSecret?: string; redirectUri?: string; auth?: "basic" | "post" };
export type TokenResponse = Record<string, Json>;

export class OAuthError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly body: Json,
  ) {
    super(`oauth error: ${code} (${status})`);
  }
}

export async function pkce() {
  const verifier = randomId(32);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)), method: "S256" as const };
}

export function authorizeUrl(endpoint: string, client: Client, params: Record<string, string>): string {
  const url = new URL(endpoint);
  for (const [k, v] of Object.entries({
    client_id: client.clientId,
    response_type: "code",
    ...(client.redirectUri ? { redirect_uri: client.redirectUri } : {}),
    ...params,
  }))
    url.searchParams.set(k, v);
  return url.toString();
}

/** POST a form with client authentication; returns status and parsed JSON (null if not JSON). */
async function post(fetchFn: typeof fetch, endpoint: string, client: Client, params: Record<string, string>) {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  const body = new URLSearchParams(params);
  if (client.auth === "basic" && client.clientSecret !== undefined)
    headers.authorization = `Basic ${btoa(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`)}`;
  else {
    body.set("client_id", client.clientId);
    if (client.clientSecret !== undefined) body.set("client_secret", client.clientSecret);
  }
  const res = await fetchFn(endpoint, { method: "POST", headers, body });
  const json = (await res.json().catch(() => null)) as Record<string, Json> | null;
  return { res, json };
}

/** Any token-endpoint grant. Throws OAuthError on an error response, including the device flow's `authorization_pending` / `slow_down`. */
export async function tokenRequest(fetchFn: typeof fetch, endpoint: string, client: Client, params: Record<string, string>) {
  const { res, json } = await post(fetchFn, endpoint, client, params);
  // Some providers (GitHub, Slack) report errors with a 200. A missing access_token is checked by
  // credentialFrom, so a definition can reshape the response first (Slack user tokens are nested).
  if (!res.ok || !json || typeof json.error === "string") throw new OAuthError(String(json?.error ?? "invalid_response"), res.status, json);
  return json as TokenResponse;
}

export const exchangeCode = (f: typeof fetch, endpoint: string, client: Client, code: string, verifier?: string) =>
  tokenRequest(f, endpoint, client, {
    grant_type: "authorization_code",
    code,
    ...(client.redirectUri ? { redirect_uri: client.redirectUri } : {}),
    ...(verifier ? { code_verifier: verifier } : {}),
  });

export const refreshGrant = (f: typeof fetch, endpoint: string, client: Client, refreshToken: string) =>
  tokenRequest(f, endpoint, client, { grant_type: "refresh_token", refresh_token: refreshToken });

export const clientCredentials = (f: typeof fetch, endpoint: string, client: Client, scope?: string) =>
  tokenRequest(f, endpoint, client, { grant_type: "client_credentials", ...(scope ? { scope } : {}) });

export type DeviceAuthorization = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
};

/** Start a device flow. Then poll `devicePoll` every `interval` seconds (default 5; +5 on `slow_down`). */
export async function deviceAuthorize(f: typeof fetch, endpoint: string, client: Client, scope?: string) {
  const { res, json } = await post(f, endpoint, client, scope ? { scope } : {});
  if (!res.ok || !json || typeof json.device_code !== "string") throw new OAuthError(String(json?.error ?? "invalid_response"), res.status, json);
  return json as unknown as DeviceAuthorization;
}

export const devicePoll = (f: typeof fetch, endpoint: string, client: Client, deviceCode: string) =>
  tokenRequest(f, endpoint, client, { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: deviceCode });

/** Dynamic client registration. Returns the provider's response (client_id, client_secret, ...). */
export async function register(f: typeof fetch, endpoint: string, metadata: Record<string, Json>, initialAccessToken?: string) {
  const res = await f(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(initialAccessToken ? { authorization: `Bearer ${initialAccessToken}` } : {}),
    },
    body: JSON.stringify(metadata),
  });
  const json = (await res.json().catch(() => null)) as Record<string, Json> | null;
  if (!res.ok || !json || typeof json.client_id !== "string") throw new OAuthError(String(json?.error ?? "invalid_response"), res.status, json);
  return json;
}

/** Revoke a token at the provider. Per RFC 7009 an unknown token is still a 200. */
export async function revoke(f: typeof fetch, endpoint: string, client: Client, token: string, hint?: "access_token" | "refresh_token") {
  const { res, json } = await post(f, endpoint, client, { token, ...(hint ? { token_type_hint: hint } : {}) });
  if (!res.ok) throw new OAuthError(String(json?.error ?? "revoke_failed"), res.status, json);
}
