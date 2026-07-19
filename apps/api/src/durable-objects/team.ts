import {
  type ConnectorConfig,
  decrypt,
  encrypt,
  isProviderName,
} from "@openconnect/shared";
import type { Env } from "../env";
import { CURRENT_KEY_VERSION, loadMasterKeys } from "../keys";

/**
 * One Team DO per team (idFromName(teamId)), holding every provider's
 * connector config (client_id/secret, redirect_uri) for that team.
 * Connection DOs call this at authorize/refresh time — a cold path, so
 * sharing one DO across providers for a team doesn't create contention.
 */
export class TeamDO {
  private readonly state: DurableObjectState;
  private readonly env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const [, provider] = url.pathname.split("/").filter(Boolean); // /connectors/:provider

    if (request.method === "PUT" && provider) {
      return this.putConnector(provider, await request.json());
    }
    if (request.method === "GET" && provider) {
      return this.getConnector(provider);
    }
    if (request.method === "GET") {
      return this.listConnectors();
    }
    if (request.method === "DELETE" && provider) {
      return this.deleteConnector(provider);
    }
    return new Response("not found", { status: 404 });
  }

  private async putConnector(
    provider: string,
    body: Omit<ConnectorConfig, "provider">
  ): Promise<Response> {
    if (!isProviderName(provider)) {
      return Response.json({ error: "unknown provider" }, { status: 400 });
    }
    const { current } = await loadMasterKeys(this.env);
    const config: ConnectorConfig = { provider, ...body };
    const encrypted = await encrypt(
      JSON.stringify(config),
      current,
      CURRENT_KEY_VERSION
    );
    await this.state.storage.put(`connector:${provider}`, encrypted);
    return Response.json({ ok: true });
  }

  /** Internal use only (called by Connection DOs) — returns decrypted secrets. */
  private async getConnector(provider: string): Promise<Response> {
    const encrypted = await this.state.storage.get<string>(
      `connector:${provider}`
    );
    if (!encrypted) {
      return new Response("not found", { status: 404 });
    }
    const { byVersion } = await loadMasterKeys(this.env);
    const config = await decrypt(encrypted, byVersion);
    return new Response(config, {
      headers: { "content-type": "application/json" },
    });
  }

  /** Dashboard-facing: which providers are configured, no secrets. */
  private async listConnectors(): Promise<Response> {
    const keys = await this.state.storage.list({ prefix: "connector:" });
    const providers = [...keys.keys()].map((key) =>
      key.replace("connector:", "")
    );
    return Response.json({ providers });
  }

  private async deleteConnector(provider: string): Promise<Response> {
    await this.state.storage.delete(`connector:${provider}`);
    return Response.json({ ok: true });
  }
}
