import { base64url, randomId } from "./crypto.ts";
import type { Json } from "./index.ts";

/** OAuth protocol atoms (RFC 6749 + PKCE). Provider-agnostic; quirks live in the caller. */

export type Client = { clientId: string; clientSecret: string; redirectUri: string; auth?: "basic" | "post" };
export type TokenResponse = Record<string, Json>;

export class OAuthError extends Error {
  constructor(readonly code: string, readonly status: number, readonly body: Json) {
    super(`oauth error: ${code} (${status})`);
  }
}

export async function pkce() {
  const verifier = randomId(32);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

export function authorizeUrl(endpoint: string, client: Client, params: Record<string, string>): string {
  const url = new URL(endpoint);
  url.search = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    response_type: "code",
    ...params,
  }).toString();
  return url.toString();
}

export async function tokenRequest(
  fetchFn: typeof fetch,
  endpoint: string,
  client: Client,
  params: Record<string, string>,
): Promise<TokenResponse> {
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };
  const body = new URLSearchParams(params);
  if (client.auth === "basic") headers.authorization = `Basic ${btoa(`${client.clientId}:${client.clientSecret}`)}`;
  else {
    body.set("client_id", client.clientId);
    body.set("client_secret", client.clientSecret);
  }
  const res = await fetchFn(endpoint, { method: "POST", headers, body });
  const json = (await res.json().catch(() => null)) as TokenResponse | null;
  // Some providers (GitHub) report errors with a 200.
  if (!res.ok || !json || typeof json.error === "string" || typeof json.access_token !== "string")
    throw new OAuthError(String(json?.error ?? "invalid_response"), res.status, json);
  return json;
}
