import { expect, test } from "bun:test";
import { apiKey, defineConnection, oauth2, rateHeaders } from "@openconnect/connections";
import { fakeOAuth } from "@openconnect/connections/testing";
import { importHmacKey, importKeys, type Json } from "@openconnect/kernel";
import { memory } from "@openconnect/kernel/memory";
import { proxy, runtime } from "./index.ts";

const TOKEN = "https://example.test/token";
const API = "https://api.example.test/v1";
const key = (n: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(n)));

const example = defineConnection({
  id: "example",
  auth: oauth2<{ clientId: string; clientSecret: string }>({ authorizeUrl: "https://example.test/authorize", tokenUrl: TOKEN }),
  proxy: { baseUrl: API },
  rate: {
    connection: { count: 2, periodMs: 60_000 },
    app: { count: 3, periodMs: 60_000 },
    observe: (res, now) => rateHeaders(res, now, { remaining: "x-remaining", reset: "x-reset" }),
  },
});
const keyed = defineConnection({ id: "keyed", auth: apiKey(["key"]), proxy: { baseUrl: API, inject: { query: "api_key" } } });
const hooked = defineConnection({
  id: "hooked",
  auth: apiKey(["user", "pass"]),
  proxy: { baseUrl: API, inject: (_u, h, c) => c.kind === "static" && h.set("authorization", `Basic ${btoa(`${c.fields.user}:${c.fields.pass}`)}`) },
});

type Upstream = (req: Request) => Response | Promise<Response>;

async function setup(o: { expiresIn?: number; timeoutMs?: number } = {}) {
  let upstream: Upstream = () => new Response("ok");
  const seen: Request[] = [];
  const p = fakeOAuth({
    tokenUrl: TOKEN,
    clientSecret: "cs",
    issue: (n) => ({ access_token: `a${n}`, refresh_token: `r${n}`, expires_in: o.expiresIn ?? 3600 }),
    error: () => ({ status: 400, body: { error: "invalid_grant" } }),
    route: (_url, req) => (seen.push(req), upstream(req)),
  });
  const settings = {
    keys: await importKeys({ 1: key(1) }, 1),
    stateKey: await importHmacKey(key(9)),
    apiKey: "secret",
    redirectUri: "https://oc.test/callback",
    config: { example: { clientId: "cid", clientSecret: "cs" }, keyed: null, hooked: null },
    fetch: p.fetch,
  };
  const rt = runtime({ definitions: { example, keyed, hooked }, settings: async () => settings, extensions: [proxy({ timeoutMs: o.timeoutMs ?? 1000 })] });
  const w = memory(rt.program);
  let settleThrows = false;
  const call = (i: string, m: string, a: Json) => (settleThrows && m === "proxy.settle" ? Promise.reject(new Error("DO gone")) : w.call(i, m, a));
  const send = (method: string, path: string, init: RequestInit = {}) =>
    rt.fetch(new Request(`https://oc.test${path}`, { method, ...init, headers: { authorization: "Bearer secret", ...init.headers } }), call);
  const connect = async (id: string) => {
    const url = ((await (await send("POST", `/connections/example/${id}/connect`)).json()) as { url: string }).url;
    const back = p.approve(url);
    await send("GET", `/callback?code=${back.code}&state=${encodeURIComponent(back.state)}`);
  };
  return { w, send, connect, seen, upstream: (f: Upstream) => void (upstream = f), breakSettle: () => void (settleThrows = true) };
}

test("injects the token, forwards method, path, query and body, strips our API key", async () => {
  const { send, connect, seen, upstream } = await setup();
  await connect("c1");
  upstream(async (req) => Response.json({ got: await req.text() }, { status: 201, headers: { "x-up": "1" } }));
  const res = await send("POST", "/proxy/example/c1/repos/a%2Fb/issues/?state=open", { body: "hi", headers: { "content-type": "text/plain" } });
  expect(res.status).toBe(201);
  expect(res.headers.get("x-up")).toBe("1");
  expect(await res.json()).toEqual({ got: "hi" });
  const up = seen.at(-1)!;
  expect(up.url).toBe(`${API}/repos/a%2Fb/issues/?state=open`); // %2F stays encoded
  expect(up.method).toBe("POST");
  expect(up.headers.get("authorization")).toBe("Bearer a1");
  expect(up.headers.get("content-type")).toBe("text/plain");
});

test("query and hook injection for static credentials", async () => {
  const { send, seen } = await setup();
  await send("POST", "/connections/keyed/k1/connect", { body: JSON.stringify({ key: "sk" }) });
  expect((await send("GET", "/proxy/keyed/k1/things?x=1")).status).toBe(200);
  expect(seen.at(-1)!.url).toBe(`${API}/things?x=1&api_key=sk`);
  expect(seen.at(-1)!.headers.get("authorization")).toBeNull();

  await send("POST", "/connections/hooked/h1/connect", { body: JSON.stringify({ user: "u", pass: "p" }) });
  await send("GET", "/proxy/hooked/h1/me");
  expect(seen.at(-1)!.headers.get("authorization")).toBe(`Basic ${btoa("u:p")}`);
});

test("rate: connection permits run out → 429 with Retry-After, upstream never called; app scope spans connections", async () => {
  const { send, connect, seen } = await setup();
  await connect("c1");
  await connect("c2");
  const before = seen.length;
  expect((await send("GET", "/proxy/example/c1/x")).status).toBe(200);
  expect((await send("GET", "/proxy/example/c1/x")).status).toBe(200);
  const denied = await send("GET", "/proxy/example/c1/x");
  expect(denied.status).toBe(429);
  expect(denied.headers.get("retry-after")).toBe("30");
  expect(denied.headers.get("openconnect-error")).toBe("rate_limited"); // ours, not the provider's
  expect(((await denied.json()) as any).error).toMatchObject({ code: "rate_limited", retryAfterMs: 30_000 });
  expect(seen.length - before).toBe(2);

  // App limit is 3: c2 gets one, then the app scope says no (and c2's own grant is refunded).
  expect((await send("GET", "/proxy/example/c2/x")).status).toBe(200);
  expect((await send("GET", "/proxy/example/c2/x")).status).toBe(429);
});

test("response headers sync the rate state: Retry-After and remaining=0 block the next request", async () => {
  const { w, send, connect, upstream } = await setup();
  await connect("c1");
  upstream(() => new Response("slow down", { status: 429, headers: { "retry-after": "120", "openconnect-error": "forged" } }));
  const r = await send("GET", "/proxy/example/c1/x");
  expect(r.status).toBe(429); // the provider's own 429 passes through as is
  expect(await r.text()).toBe("slow down");
  expect(r.headers.has("openconnect-error")).toBe(false); // only the runtime's own errors carry it
  const blocked = await send("GET", "/proxy/example/c1/x");
  expect(blocked.status).toBe(429);
  expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThanOrEqual(120);

  await w.advance(180_000);
  upstream(() => new Response("ok", { headers: { "x-remaining": "0", "x-reset": String((w.now() + 600_000) / 1000) } }));
  expect((await send("GET", "/proxy/example/c1/x")).status).toBe(200);
  expect(Number((await send("GET", "/proxy/example/c1/x")).headers.get("retry-after"))).toBeGreaterThanOrEqual(600);
});

test("streams both bodies without buffering", async () => {
  const { send, connect, seen, upstream } = await setup();
  await connect("c1");
  let close!: () => void;
  upstream(
    () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode("first"));
            close = () => c.close();
          },
        }),
      ),
  );
  const body = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode("up"));
      c.close();
    },
  });
  const res = await send("PUT", "/proxy/example/c1/upload", { body, duplex: "half" } as RequestInit);
  const reader = res.body!.getReader();
  // The first chunk arrives while upstream is still open.
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
  close();
  expect((await reader.read()).done).toBe(true);
  expect(await seen.at(-1)!.text()).toBe("up");
});

test("refreshes a token about to expire before proxying", async () => {
  const { send, connect, seen } = await setup({ expiresIn: 30 });
  await connect("c1");
  await send("GET", "/proxy/example/c1/x");
  expect(seen.at(-1)!.headers.get("authorization")).toBe("Bearer a2");
});

test("non-active connection → 409, no permit used; bad routes", async () => {
  const { send, connect } = await setup();
  const missing = await send("GET", "/proxy/example/nope/x");
  expect(missing.status).toBe(409);
  expect(((await missing.json()) as any).error).toMatchObject({ code: "not_active", state: "missing" });
  await connect("c1");
  await send("POST", "/connections/example/c1/revoke");
  expect((await send("GET", "/proxy/example/c1/x")).status).toBe(409);

  // Dot segments resolve before routing, so they can't climb out of the base path.
  expect((await send("GET", "/proxy/example/c1/%2e%2e/%2e%2e/evil")).status).toBe(404);
  expect((await send("GET", "/proxy/nope/c1/x")).status).toBe(404);
  expect((await send("GET", "/proxy/example")).status).toBe(404);
  expect((await send("GET", "/proxy/example/c1/x", { headers: { authorization: "Bearer nope" } })).status).toBe(401);
});

test("upstream timeout → 504, network error → 502 and the permit is refunded", async () => {
  const { send, connect, upstream } = await setup({ timeoutMs: 20 });
  await connect("c1");
  upstream((req) => new Promise((_, no) => req.signal.addEventListener("abort", () => no(new Error("aborted")))));
  expect((await send("GET", "/proxy/example/c1/x")).status).toBe(504);
  upstream(() => Promise.reject(new Error("connection refused")));
  expect((await send("GET", "/proxy/example/c1/x")).status).toBe(502);
  // One permit left of two: the timed-out request used one, the refused one was refunded.
  upstream(() => new Response("ok"));
  expect((await send("GET", "/proxy/example/c1/x")).status).toBe(200);
  expect((await send("GET", "/proxy/example/c1/x")).status).toBe(429);
});

test("a failing settle never costs the caller the upstream response", async () => {
  const { send, connect, upstream, breakSettle } = await setup();
  await connect("c1");
  breakSettle();
  upstream(() => Response.json({ created: true }, { status: 201 }));
  const res = await send("POST", "/proxy/example/c1/things", { body: "{}" });
  expect(res.status).toBe(201);
  expect(await res.json()).toEqual({ created: true });
  upstream(() => Promise.reject(new Error("connection refused")));
  expect((await send("POST", "/proxy/example/c1/things")).status).toBe(502);
});

test("proxy.prepare and proxy.settle are RPC-only: refused over /connections, fine from the proxy route", async () => {
  const { w, send, connect } = await setup();
  await connect("c1");
  for (const m of ["proxy.prepare", "proxy.settle"]) expect((await send("POST", `/connections/example/c1/${m}`, { body: "{}" })).status).toBe(404);
  expect(await w.call("conn:example:c1", "proxy.prepare", null)).toMatchObject({ ok: { credential: { accessToken: "a1" } } });
  expect(await w.call("conn:example:c1", "proxy.settle", { refund: true })).toEqual({ ok: null });
});
