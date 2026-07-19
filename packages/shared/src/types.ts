import type { ProviderName } from "./providers";

/** Per-team, per-provider client credentials. Stored encrypted in the Team DO. */
export type ConnectorConfig = {
  provider: ProviderName;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

/** A single OAuth grant, held by a Connection DO (team:provider:tenant). */
export type Grant = {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  grantedScopes: string[];
  tokenType: "Bearer";
  status: "active" | "revoked" | "needs_reauth";
};

/** Transient state for one in-flight authorize attempt, held in the same Connection DO. */
export type AuthAttempt = {
  state: string;
  codeVerifier: string;
  requestedScopes: string[];
  expiresAt: number;
};

/** Row shape for the D1 `connections` index — metadata only, never secrets. */
export type ConnectionIndexRow = {
  do_name: string;
  team_id: string;
  provider: ProviderName;
  tenant_id: string;
  status: Grant["status"];
  scopes: string;
  created_at: number;
  updated_at: number;
};
