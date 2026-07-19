import { AuthError } from "./auth";
import type { Env } from "./env";
import { handleManagementRoute } from "./routes/management";
import { handleUsageRoute } from "./routes/usage";

// biome-ignore lint/performance/noBarrelFile: Workers requires DO classes exported from the main module
export { ConnectionDO } from "./durable-objects/connection";
export { TeamDO } from "./durable-objects/team";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/v1/")) {
        return await handleUsageRoute(request, env, url);
      }
      if (url.pathname.startsWith("/management/")) {
        return await handleManagementRoute(request, env, url);
      }
      // Everything else falls through to the dashboard's static assets
      // (configured via the [assets] binding in wrangler.toml) — no route here.
      return new Response("not found", { status: 404 });
    } catch (error) {
      if (error instanceof AuthError) {
        return Response.json(
          { error: error.message },
          { status: error.status }
        );
      }
      throw error;
    }
  },
} satisfies ExportedHandler<Env>;
