import type { Handler } from "@openconnect/kernel";
import { durableObject } from "@openconnect/kernel/do";
import type { Runtime } from "./runtime.ts";

/**
 * The runtime on Cloudflare: one DO class for every connection, and the Worker's fetch in front.
 *
 *   const cf = cloudflare(runtime({ definitions, settings }), { binding: "CONNECTION" });
 *   export class Connection extends cf.ConnectionDO {}
 *   export default { fetch: cf.fetch };
 */
export function cloudflare(rt: Runtime, opts: { binding: string; now?: () => number }) {
  return {
    ConnectionDO: durableObject(rt.program, opts),
    fetch(req: Request, env: Record<string, unknown>) {
      const ns = env[opts.binding] as DurableObjectNamespace;
      return rt.fetch(req, (i, m, a) => (ns.get(ns.idFromName(i)) as unknown as Handler).onCall(m, a));
    },
  };
}
