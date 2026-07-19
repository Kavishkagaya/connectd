import { verifyToken } from "@clerk/backend";
import type { Env } from "./env";

export class AuthError extends Error {
  status = 401;
}

const HEX_RADIX = 16;

function bearerToken(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) {
    throw new AuthError("missing bearer token");
  }
  return token;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(HEX_RADIX).padStart(2, "0"))
    .join("");
}

/** Auth for /v1/* usage routes: a team's `sk_...` secret key, hashed and looked up in D1. */
export async function requireApiKey(
  request: Request,
  env: Env
): Promise<string> {
  const token = bearerToken(request);
  const keyHash = await sha256Hex(token);
  const row = await env.DB.prepare(
    "SELECT team_id FROM api_keys WHERE key_hash = ?1 AND revoked_at IS NULL"
  )
    .bind(keyHash)
    .first<{ team_id: string }>();
  if (!row) {
    throw new AuthError("invalid api key");
  }
  return row.team_id;
}

/** Auth for /management/* routes: a Clerk session JWT. Clerk org id doubles as our `team` id. */
export async function requireClerkSession(
  request: Request,
  env: Env
): Promise<string> {
  const token = bearerToken(request);
  const result = await verifyToken(token, {
    secretKey: env.CLERK_SECRET_KEY,
    jwtKey: env.CLERK_JWT_KEY,
  });
  if (!result.org_id) {
    throw new AuthError("no active organization on this session");
  }
  return result.org_id;
}
