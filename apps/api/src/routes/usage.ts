import { isProviderName, verifyState } from "@openconnect/shared";
import { requireApiKey } from "../auth";
import { updateConnectionStatus } from "../connection-index";
import type { Env } from "../env";
import { loadStateSigningKey } from "../keys";

const CONNECTION_ACTION_PATH =
  /^\/v1\/connections\/([^/]+)\/([^/]+)\/(token|revoke)$/;

function connectionDoName(
  team: string,
  provider: string,
  tenant: string
): string {
  return `${team}:${provider}:${tenant}`;
}

function getConnectionStub(env: Env, doName: string) {
  return env.CONNECTION_DO.get(env.CONNECTION_DO.idFromName(doName));
}

export async function handleUsageRoute(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  // The callback is hit directly by the user's browser via a provider redirect —
  // it carries no API key, only a signed `state`. Trust comes from that signature.
  if (url.pathname === "/v1/oauth/callback" && request.method === "GET") {
    return handleCallback(env, url);
  }

  const teamId = await requireApiKey(request, env);

  if (url.pathname === "/v1/oauth/start" && request.method === "POST") {
    return handleStart(request, env, teamId);
  }

  const match = url.pathname.match(CONNECTION_ACTION_PATH);
  if (match) {
    return handleConnectionAction(request, env, teamId, match);
  }

  return new Response("not found", { status: 404 });
}

async function handleStart(
  request: Request,
  env: Env,
  teamId: string
): Promise<Response> {
  const body = await request.json<{
    provider: string;
    tenant: string;
    scopes?: string[];
  }>();
  if (!isProviderName(body.provider)) {
    return Response.json({ error: "unknown provider" }, { status: 400 });
  }
  const doName = connectionDoName(teamId, body.provider, body.tenant);
  return getConnectionStub(env, doName).fetch("https://connection-do/start", {
    method: "POST",
    body: JSON.stringify({
      team: teamId,
      provider: body.provider,
      tenant: body.tenant,
      scopes: body.scopes ?? [],
    }),
  });
}

function handleConnectionAction(
  request: Request,
  env: Env,
  teamId: string,
  match: RegExpMatchArray
): Response | Promise<Response> {
  const [, provider, tenant, action] = match;
  const doName = connectionDoName(teamId, provider ?? "", tenant ?? "");
  const stub = getConnectionStub(env, doName);
  if (action === "token" && request.method === "GET") {
    return stub.fetch("https://connection-do/token");
  }
  if (action === "revoke" && request.method === "POST") {
    return stub.fetch("https://connection-do/revoke", { method: "POST" });
  }
  return new Response("not found", { status: 404 });
}

async function handleCallback(env: Env, url: URL): Promise<Response> {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!(code && state)) {
    return new Response("missing code/state", { status: 400 });
  }

  const signingKey = await loadStateSigningKey(env);
  const doName = await verifyState(state, signingKey);
  if (!doName) {
    return new Response("invalid state", { status: 400 });
  }

  const stub = getConnectionStub(env, doName);
  const response = await stub.fetch("https://connection-do/callback", {
    method: "POST",
    body: JSON.stringify({ code, state }),
  });

  if (!response.ok) {
    await updateConnectionStatus(env, doName, "needs_reauth").catch(() => {
      // ponytail: best-effort index update — the DO's own status is the source of truth.
    });
    return new Response("connection failed, close this window and retry", {
      status: 400,
    });
  }

  // Standard popup pattern: notify the opener and close, no dashboard round-trip needed.
  return new Response(
    `<script>window.opener?.postMessage({ type: "openconnect:connected" }, "*"); window.close();</script>`,
    { headers: { "content-type": "text/html" } }
  );
}
