import { apiKey, defineConnection, hmacHex, safeEqual } from "@kavishkagaya/connectd-connections";
import { importHmacKey, importKeys, type Platform } from "@kavishkagaya/connectd-kernel";
import { importKey } from "../src/access.ts";
import { cloudflare } from "../src/cloudflare.ts";
import { directory } from "../src/directory.ts";
import { events } from "../src/events.ts";
import { runtime } from "../src/runtime.ts";
import { webhooks } from "../src/webhooks.ts";

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
  // `x-sig` = hex HMAC of the body: the connection's secret per connection, "app" on the app route (routed by `account`).
  webhooks: {
    verify: async (_ctx, req, secret) => safeEqual(req.headers.get("x-sig") ?? "", await hmacHex(secret ?? "app", req.body)),
    parse(req) {
      const b = JSON.parse(req.body) as { type: string; account?: string };
      return { topic: b.type, payload: b, ...(b.account ? { external: { key: "account", value: b.account } } : {}) };
    },
  },
});

export const OPTS = {
  binding: "CONNECTION",
  db: "INDEX",
  now: () => g.ocNow!,
  // The provider rejects key "bad", so a throwing hook can be tested across the DO boundary.
  fetch: async (url: Request | string | URL) => new Response(null, { status: String(url).endsWith("=bad") ? 401 : 200 }),
};

const settings = async () => ({
  keys: await importKeys({ 1: key(1) }, 1),
  stateKey: await importHmacKey(key(9)),
  admin: await importHmacKey(key(8)),
  redirectUri: "https://oc.test/callback",
  config: { keyed: null },
  // Delivery runs from alarms, which never fire under the fake clock; the outbox is what's checked.
  events: { url: "https://app.test/events" },
  webhooks: { url: "https://oc.test/webhooks", key: await importHmacKey(key(5)) },
});

/** The tests' API key, in D1 (`seed` puts it there after each reset). */
export const TEST_KEY = "ock_000000000000_secret";
export const seed = async (p: Platform) => importKey(p, (await settings()).keys, "api", "test", TEST_KEY);
export const adminKey = async () => (await settings()).admin;

const rt = runtime({
  definitions: { keyed },
  settings,
  extensions: [directory(), events(), webhooks()],
});

const cf = cloudflare(rt, OPTS);
export class Connection extends cf.ConnectionDO {}
export default { fetch: cf.fetch };
