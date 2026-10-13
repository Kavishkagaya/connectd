import { apiKey, defineConnection } from "@openconnect/connections";
import { importHmacKey, importKeys } from "@openconnect/kernel";
import { cloudflare, d1Index } from "../src/cloudflare.ts";
import { directory } from "../src/directory.ts";
import { runtime } from "../src/runtime.ts";

// Fake clock, far in the future so real alarms never fire on their own during tests.
const g = globalThis as { ocNow?: number };
g.ocNow ??= Date.now() + 10 * 365 * 86400_000;

const key = (n: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(n)));

const keyed = defineConnection({
  id: "keyed",
  auth: apiKey(["key"]),
  async metadata(ctx, cred) {
    const account = cred.kind === "static" ? (cred.fields.key ?? "") : "";
    const res = await ctx.fetch(`https://provider.test/me?key=${account}`);
    if (!res.ok) throw new Error(`/me ${res.status}`);
    return { account };
  },
  external: (m) => ({ account: m.account }),
});

export const index = d1Index("INDEX");

const rt = runtime({
  definitions: { keyed },
  settings: async () => ({
    keys: await importKeys({ 1: key(1) }, 1),
    stateKey: await importHmacKey(key(9)),
    apiKey: "secret",
    redirectUri: "https://oc.test/callback",
    config: { keyed: null },
    // The provider rejects key "bad", so a throwing hook can be tested across the DO boundary.
    fetch: (async (url: RequestInfo | URL) => new Response(null, { status: String(url).endsWith("=bad") ? 401 : 200 })) as typeof fetch,
  }),
  extensions: [directory(index)],
});

const cf = cloudflare(rt, { binding: "CONNECTION", now: () => g.ocNow! });
export class Connection extends cf.ConnectionDO {}
export default { fetch: cf.fetch };
