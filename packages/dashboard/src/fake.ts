import { action, apiKey, defineConnection, hmacHex, oauth2, type StandardSchemaV1, safeEqual } from "@kavishkagaya/connectd-connections";
import { fakeOAuth } from "@kavishkagaya/connectd-connections/testing";
import { importHmacKey, importKeys, type Json } from "@kavishkagaya/connectd-kernel";
import { memory } from "@kavishkagaya/connectd-kernel/memory";
import { directory, type Extension, events, importKey, newSession, runtime, SESSION_COOKIE, token, webhooks } from "@kavishkagaya/connectd-runtime";
import { dashboard } from "./index.ts";

/**
 * Tests and the e2e script only: the real runtime with dashboard() on the memory driver, an API key
 * and an events secret seeded, and a root session (what a CLI link gives) for the dashboard's API.
 */

export const OC = "https://oc.test";
export const API_KEY = "ock_000000000000_test-api-key";
export const CLIENT_SECRET = "shh-client-secret";
export const T0 = 1_700_000_000_000;
const key = (n: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(n)));
export const EVENTS_SECRET = `whsec_${key(7)}`;
const TOKEN = "https://example.test/token";

/** `{ repo: string, stars?: number }`, with its JSON Schema (Standard JSON Schema), like zod 4 gives. */
const repoInput = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (v: unknown) =>
      typeof v === "object" && v !== null && typeof (v as { repo?: unknown }).repo === "string"
        ? { value: v as { repo: string; stars?: number } }
        : { issues: [{ message: "Expected string", path: ["repo"] }] },
    jsonSchema: { input: () => ({ type: "object", properties: { repo: { type: "string", description: "owner/name" }, stars: { type: "number" } }, required: ["repo"] }) },
  },
} as StandardSchemaV1<{ repo: string; stars?: number }>;
/** A schema without a JSON Schema: the form falls back to a JSON text box. */
const anyInput: StandardSchemaV1<Json> = { "~standard": { version: 1, vendor: "test", validate: (v) => ({ value: v as Json }) } };
const subInput: StandardSchemaV1<{ repo: string }> = {
  "~standard": { version: 1, vendor: "test", validate: (v) => (typeof (v as { repo?: unknown })?.repo === "string" ? { value: v as { repo: string } } : { issues: [{ message: "repo" }] }) },
};

/** Scheduled `tick` fails while this is above 0. */
export const tickFailures = { left: 0 };
const keyedActions = {
  star: action({ input: repoInput, run: async (_c, { repo, stars }) => ({ starred: repo, stars: stars ?? null }) }),
  echo: action({ input: anyInput, run: async (_c, v) => ({ echo: v }) }),
  tick: action({
    every: 10 * 60_000,
    run: async () => {
      if (tickFailures.left > 0) {
        tickFailures.left--;
        throw new Error("provider down");
      }
      return { ok: true };
    },
  }),
};

const keyed = defineConnection({
  id: "keyed",
  auth: apiKey(["apiKey"]),
  metadata: async (_ctx, cred) => ({ account: cred.kind === "static" ? (cred.fields.apiKey ?? "") : "" }),
  external: (m) => ({ account: m.account }),
  proxy: { baseUrl: "https://api.keyed.test" },
  webhooks: {
    verify: async (_ctx, req, secret) => safeEqual(req.headers.get("x-sig") ?? "", await hmacHex(secret ?? "app", req.body)),
    parse: (req) => ({ topic: (JSON.parse(req.body) as { topic?: string }).topic ?? "push", payload: JSON.parse(req.body) as Json }),
    subscription: subInput,
    register: async (_ctx, _cred, _endpoint, input) => ({ hook: { repo: input.repo } }),
    unregister: async () => {},
  },
});
const oauth = (id: string) => defineConnection({ id, auth: oauth2<{ clientId: string; clientSecret?: string }>({ authorizeUrl: "https://example.test/authorize", tokenUrl: TOKEN }) });

export async function setup(o: { extensions?: Extension[] } = {}) {
  let status = 200;
  const delivered: string[] = [];
  const p = fakeOAuth({ tokenUrl: TOKEN, issue: (n) => ({ access_token: `a${n}` }), error: () => ({ status: 400, body: { error: "invalid_grant" } }) });
  /** The providers and the app, as the platform's outbound fetch. */
  const upstream = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).startsWith("https://app.test/events")) {
      if (status < 300) delivered.push(init?.body as string);
      return new Response(null, { status });
    }
    return p.fetch(url, init);
  }) as typeof fetch;
  const settings = {
    keys: await importKeys({ 1: key(1) }, 1),
    stateKey: await importHmacKey(key(9)),
    admin: await importHmacKey(key(8)),
    redirectUri: `${OC}/callback`,
    config: { keyed: null, example: { clientId: "cid", clientSecret: CLIENT_SECRET }, half: { clientId: "", clientSecret: undefined } },
    events: { url: "https://app.test/events?token=in-the-url" },
    webhooks: { url: `${OC}/webhooks`, key: await importHmacKey(key(5)) },
    sessions: { key: await importHmacKey(key(4)), origins: ["https://app.test"] },
  };
  let w: ReturnType<typeof memory> | undefined;
  const rt = runtime({
    definitions: { keyed, example: oauth("example"), half: oauth("half"), absent: oauth("absent") },
    actions: { keyed: keyedActions },
    settings: async () => settings,
    extensions: o.extensions ?? [events(), webhooks(), directory(), dashboard()],
  });
  w = memory(rt.program, { fetch: upstream, now: T0 });
  await importKey(w.platform, settings.keys, "api", "test", API_KEY);
  await importKey(w.platform, settings.keys, "events", "test", EVENTS_SECRET);
  const root = await newSession(w.platform, settings.admin, null);
  /** A root session's cookie (as a CLI link gives). */
  const cookie = `${SESSION_COOKIE}=${encodeURIComponent(root!.token)}`;
  const send = (path: string, init: RequestInit = {}) => rt.fetch(new Request(new URL(path, OC), init), w!.platform);
  /** The API key for the runtime's routes, the root session for the dashboard's, this origin for writes. */
  const api = async (path: string, body?: Json, method = body === undefined ? "GET" : "POST", headers: Record<string, string> = {}) => {
    const res = await send(path, { method, headers: { authorization: `Bearer ${API_KEY}`, cookie, origin: OC, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: (await res.json()) as any, headers: res.headers };
  };
  /** A CLI sign-in link's token (what `connectd dashboard` puts after `#login=`). */
  const loginToken = () => token(settings.admin, "login", w!.now(), 5 * 60_000);
  return { w, rt, settings, fetch: send, api, cookie, loginToken, delivered, failEvents: (s: number) => void (status = s) };
}

