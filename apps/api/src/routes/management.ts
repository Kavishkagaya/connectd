import { requireClerkSession, sha256Hex } from "../auth";
import type { Env } from "../env";

const CONNECTOR_PATH = /^\/management\/connectors\/([^/]+)$/;
const API_KEY_PATH = /^\/management\/api-keys\/([^/]+)$/;

function getTeamStub(env: Env, teamId: string) {
  return env.TEAM_DO.get(env.TEAM_DO.idFromName(teamId));
}

export async function handleManagementRoute(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  const teamId = await requireClerkSession(request, env);

  const connectorMatch = url.pathname.match(CONNECTOR_PATH);
  if (connectorMatch) {
    const [, provider] = connectorMatch;
    const stub = getTeamStub(env, teamId);
    if (request.method === "PUT") {
      return stub.fetch(`https://team-do/${provider}`, {
        method: "PUT",
        body: await request.text(),
      });
    }
    if (request.method === "DELETE") {
      return stub.fetch(`https://team-do/${provider}`, { method: "DELETE" });
    }
  }
  if (url.pathname === "/management/connectors" && request.method === "GET") {
    return getTeamStub(env, teamId).fetch("https://team-do/");
  }

  if (url.pathname === "/management/api-keys" && request.method === "POST") {
    return createApiKey(env, teamId);
  }
  const apiKeyMatch = url.pathname.match(API_KEY_PATH);
  if (apiKeyMatch && request.method === "DELETE") {
    await env.DB.prepare(
      "UPDATE api_keys SET revoked_at = ?1 WHERE id = ?2 AND team_id = ?3"
    )
      .bind(Date.now(), apiKeyMatch[1], teamId)
      .run();
    return Response.json({ ok: true });
  }

  if (url.pathname === "/management/connections" && request.method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT do_name, provider, tenant_id, status, scopes, created_at FROM connections WHERE team_id = ?1"
    )
      .bind(teamId)
      .all();
    return Response.json({ connections: results });
  }

  return new Response("not found", { status: 404 });
}

async function createApiKey(env: Env, teamId: string): Promise<Response> {
  const raw = `sk_live_${crypto.randomUUID().replaceAll("-", "")}`;
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO api_keys (id, team_id, key_hash, created_at) VALUES (?1, ?2, ?3, ?4)"
  )
    .bind(id, teamId, await sha256Hex(raw), Date.now())
    .run();
  // Shown once — only the hash is ever stored, same as Stripe/GitHub token UX.
  return Response.json({ id, key: raw });
}
