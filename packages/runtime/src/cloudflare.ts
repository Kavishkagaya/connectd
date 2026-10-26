import { type CloudflareOptions, cloudflarePlatform, durableObject } from "@kavishkagaya/connectd-kernel/do";
import type { Runtime } from "./runtime.ts";

export { cloudflarePlatform };

/**
 * The runtime on the Cloudflare platform: one DO class for every connection's atom, and the
 * Worker's fetch in front. Everything Cloudflare-specific is the platform's (kernel `/do`).
 *
 *   const cf = cloudflare(runtime({ definitions, settings }), { binding: "CONNECTION", db: "INDEX" });
 *   export class Connection extends cf.ConnectionDO {}
 *   export default { fetch: cf.fetch };
 */
export function cloudflare(rt: Runtime, opts: CloudflareOptions) {
  return {
    ConnectionDO: durableObject(rt.program, opts),
    fetch(req: Request, env: Record<string, unknown>, ctx?: { waitUntil(p: Promise<unknown>): void }) {
      return rt.fetch(req, cloudflarePlatform(env, opts, ctx ? (p) => ctx.waitUntil(p) : undefined));
    },
  };
}
