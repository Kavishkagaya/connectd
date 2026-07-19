export type Env = {
  DB: D1Database;
  TEAM_DO: DurableObjectNamespace;
  CONNECTION_DO: DurableObjectNamespace;
  MASTER_KEY_V1: string; // base64, AES-256-GCM key — set via `wrangler secret put`
  STATE_SIGNING_KEY: string; // base64, HMAC-SHA256 key — set via `wrangler secret put`
  CLERK_SECRET_KEY: string;
  CLERK_JWT_KEY: string; // Clerk's PEM JWKS key, for networkless verification
};
