import { apiKey, defineConnection, type OAuth2, oauth2 } from "@openconnect/connections";
import { fakeOAuth } from "@openconnect/connections/testing";
import { importHmacKey, importKeys } from "@openconnect/kernel";
import { memory } from "@openconnect/kernel/memory";
import { directory, emit, events, type Extension, memoryIndex, proxy, runtime, sessions } from "@openconnect/runtime";
import { openconnect } from "./client.ts";

/** The real runtime on the memory driver, fake providers, and an SDK client pointed at its fetch. Tests only. */

const TOKEN = "https://example.test/token";
export const API = "https://api.example.test/v1";
export const EVENTS = "https://app.test/events";
const key = (n: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(n)));
export const SECRET = `whsec_${key(7)}`;
export const T0 = 1_700_000_000_000;

const example = defineConnection({
  id: "example",
  auth: oauth2<{ clientId: string; clientSecret: string }>({ authorizeUrl: "https://example.test/authorize", tokenUrl: TOKEN }),
  async metadata(ctx, cred) {
    const res = await ctx.fetch("https://example.test/me", { headers: { authorization: `Bearer ${(cred as OAuth2).accessToken}` } });
    return (await res.json()) as { login: string };
  },
  external: (m) => ({ login: m.login }),
  proxy: { baseUrl: API },
  rate: { connection: { count: 2, periodMs: 60_000 } },
});
const keyed = defineConnection({ id: "keyed", auth: apiKey(["key"]), proxy: { baseUrl: API, inject: { query: "api_key" } } });

// A webhooks stand-in (#25): a method that queues a `webhook.<topic>` event.
const hook: Extension = { connection: (h) => ({ methods: { hook: async (a) => (await emit(h, a, `webhook.${(a as { topic?: string } | null)?.topic ?? "push"}`), null) } }) };

type Handler = (req: Request) => Response | Promise<Response>;

export async function setup() {
  let upstream: Handler = () => new Response("ok");
  let receiver: Handler = () => new Response(null, { status: 204 });
  const seen: Request[] = [];
  let login = "octo";
  const p = fakeOAuth({
    tokenUrl: TOKEN,
    clientSecret: "cs",
    issue: (n) => ({ access_token: `a${n}`, refresh_token: `r${n}`, expires_in: 3600 }),
    error: () => ({ status: 400, body: { error: "invalid_grant" } }),
    route: (url, req) => {
      if (url === "https://example.test/me") return Response.json({ login });
      if (url === EVENTS) return receiver(req);
      seen.push(req);
      return upstream(req);
    },
  });
  const settings = {
    keys: await importKeys({ 1: key(1) }, 1),
    stateKey: await importHmacKey(key(9)),
    apiKey: "secret",
    redirectUri: "https://oc.test/callback",
    config: { example: { clientId: "cid", clientSecret: "cs" }, keyed: null },
    fetch: p.fetch,
    events: { url: EVENTS, secret: SECRET },
    sessions: { key: await importHmacKey(key(5)), origins: ["https://app.test"] },
  };
  let clock = () => T0;
  const rt = runtime({
    definitions: { example, keyed },
    settings: async () => settings,
    extensions: [proxy(), events(), directory(memoryIndex()), sessions(), hook],
    now: () => clock(),
  });
  const w = memory(rt.program, { now: T0 });
  clock = w.now;
  const sleeps: number[] = [];
  const oc = openconnect({
    url: "https://oc.test/",
    apiKey: "secret",
    fetch: (input, init) => rt.fetch(new Request(input, init), w.call),
    sleep: (ms) => (sleeps.push(ms), w.advance(ms)),
  });
  /** connect + the user approving at the provider + the provider redirecting to /callback. */
  const authorize = async (id: string, as = "octo") => {
    login = as;
    const { url } = await oc.connection("example", id).connect();
    const back = p.approve(url!);
    const res = await rt.fetch(new Request(`https://oc.test/callback?code=${back.code}&state=${encodeURIComponent(back.state)}`), w.call);
    if (!res.ok) throw new Error(`callback ${res.status}`);
  };
  return {
    rt,
    w,
    oc,
    authorize,
    seen,
    sleeps,
    upstream: (f: Handler) => void (upstream = f),
    receiver: (f: Handler) => void (receiver = f),
  };
}
