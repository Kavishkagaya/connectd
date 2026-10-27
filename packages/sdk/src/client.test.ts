import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { ConnectdError, connectd } from "./index.ts";
import { API, setup, T0 } from "./testing.ts";

const rejects = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof ConnectdError) return e;
    throw e;
  }
  throw new Error("expected a ConnectdError");
};

test("oauth2: connect, status, token, revoke", async () => {
  const t = await setup();
  const c = t.oc.connection("example", "u1");
  const { url } = await c.connect();
  expect(url).toStartWith("https://example.test/authorize?");
  expect(await c.status()).toEqual({ state: "pending", metadata: null });

  await t.authorize("u1");
  expect(await c.status()).toEqual({ state: "active", metadata: { login: "octo" } });
  expect(await c.token()).toMatchObject({ kind: "oauth2", accessToken: "a1" });

  expect(await c.revoke("user left")).toEqual({ state: "revoked", reason: "user left", metadata: { login: "octo" } });
  const e = await rejects(c.token());
  expect(e).toMatchObject({ code: "not_active", status: 409, state: "revoked", reason: "user left" });
  expect(e.message).toBeString();
});

test("api key: connect finishes inline; call reaches extension methods", async () => {
  const t = await setup();
  const k = t.oc.connection("keyed", "a/b"); // ids are path-encoded
  expect(await k.connect({ key: "sk" })).toEqual({ url: null });
  expect(await k.status()).toEqual({ state: "active", metadata: null });
  expect(await k.token()).toEqual({ kind: "static", fields: { key: "sk" } });
  expect(await k.call("index.sync")).toBeNull();
});

test("session: a browser token for one connection, from an allowlisted origin", async () => {
  const t = await setup();
  const s = await t.oc.connection("keyed", "k1").session({ origin: "https://app.test", ttlMs: 60_000 });
  expect(s.expiresAt).toBe(T0 + 60_000);
  const info = await t.rt.fetch(new Request("https://oc.test/session", { headers: { origin: "https://app.test", authorization: `Bearer ${s.token}` } }), t.w.platform);
  expect(await info.json()).toMatchObject({ definition: "keyed", id: "k1", flow: "form", fields: ["key"] });
  expect(await rejects(t.oc.connection("keyed", "k1").session({ origin: "https://evil.test" }))).toMatchObject({ code: "forbidden", status: 403 });
});

test("errors are ConnectdError with the runtime's code and status", async () => {
  const t = await setup();
  expect(await rejects(t.oc.connection("example", "nobody").status())).toMatchObject({ code: "not_found", status: 404 });
  expect(await rejects(t.oc.connection("nope", "x").status())).toMatchObject({ code: "not_found", status: 404 });
  expect(await rejects(t.oc.connection("keyed", "k").connect({ wrong: "x" }))).toMatchObject({ code: "bad_request", status: 400 });
  expect(await rejects(t.oc.connection("keyed", "k").call("proxy.prepare"))).toMatchObject({ code: "not_found", status: 404 });

  const wrongKey = connectd({ url: "https://oc.test", apiKey: "nope", fetch: (i, init) => t.rt.fetch(new Request(i, init), t.w.platform) });
  expect(await rejects(wrongKey.connection("keyed", "k").status())).toMatchObject({ code: "unauthorized", status: 401 });

  // Something in front of the runtime answering HTML.
  const gateway = connectd({ url: "https://oc.test", apiKey: "secret", fetch: async () => new Response("<h1>Bad Gateway</h1>", { status: 502 }) });
  expect(await rejects(gateway.connection("keyed", "k").status())).toMatchObject({ code: "http_error", status: 502, message: "<h1>Bad Gateway</h1>" });
});

test("list: filters, and an async iterator over cursor pages", async () => {
  const t = await setup();
  for (const id of ["k1", "k2", "k3", "k4", "k5"]) await t.oc.connection("keyed", id).connect({ key: id });
  await t.oc.connection("keyed", "k3").revoke();
  await t.authorize("u1", "octo");
  await t.authorize("u2", "hubot");

  const ids = async (q: Parameters<typeof t.oc.connections.list>[0]) => {
    const out: string[] = [];
    for await (const r of t.oc.connections.list(q)) out.push(`${r.def}/${r.id}`);
    return out;
  };
  expect(await ids({ limit: 2 })).toEqual(["example/u1", "example/u2", "keyed/k1", "keyed/k2", "keyed/k3", "keyed/k4", "keyed/k5"]);
  expect(await ids({ def: "keyed", state: "active", limit: 1 })).toEqual(["keyed/k1", "keyed/k2", "keyed/k4", "keyed/k5"]);
  expect(await ids({ external: { key: "login", value: "hubot" } })).toEqual(["example/u2"]);
  expect(await ids({ q: "OCT" })).toEqual(["example/u1"]);

  const first = await t.oc.connections.page({ def: "keyed", limit: 3 });
  expect(first.connections.map((r) => r.id)).toEqual(["k1", "k2", "k3"]);
  expect(first.connections[2]).toMatchObject({ state: "revoked", external: {} });
  const next = await t.oc.connections.page({ def: "keyed", limit: 3, cursor: first.cursor! });
  expect([next.connections.map((r) => r.id), next.cursor]).toEqual([["k4", "k5"], null]);
  expect(await rejects(t.oc.connections.page({ limit: 500 }))).toMatchObject({ code: "bad_request", status: 400 });
});

test("fetch goes through the proxy; provider responses come back as they are", async () => {
  const t = await setup();
  await t.authorize("u1");
  t.upstream(async (req) => Response.json({ got: await req.text() }, { status: 201, headers: { "x-up": "1" } }));
  const c = t.oc.connection("example", "u1");
  const res = await c.fetch("/repos/a%2Fb/issues?state=open", { method: "POST", body: "hi", headers: { "content-type": "text/plain" } });
  expect(res.status).toBe(201);
  expect(res.headers.get("x-up")).toBe("1");
  expect(await res.json()).toEqual({ got: "hi" });
  const up = t.seen.at(-1)!;
  expect(up.url).toBe(`${API}/repos/a%2Fb/issues?state=open`);
  expect(up.headers.get("authorization")).toBe("Bearer a1"); // the provider token, not our API key
  expect(up.headers.get("content-type")).toBe("text/plain");

  // A provider error is the provider's response, not a thrown error, even if it imitates ours.
  t.upstream(() => Response.json({ error: { code: "not_active", status: 404, message: "x" } }, { status: 404, headers: { "connectd-error": "not_active" } }));
  const miss = await t.oc.connection("example", "u1").fetch("missing");
  expect(miss.status).toBe(404);
  expect(miss.headers.has("connectd-error")).toBe(false);

  // What the runtime refused throws.
  expect(await rejects(t.oc.connection("example", "ghost").fetch("/user"))).toMatchObject({ code: "not_active", status: 409, state: "missing" });

  // Static credentials, injected as a query parameter.
  await t.oc.connection("keyed", "k1").connect({ key: "sk" });
  t.upstream(() => new Response("ok"));
  await t.oc.connection("keyed", "k1").fetch("things");
  expect(t.seen.at(-1)!.url).toBe(`${API}/things?api_key=sk`);
});

test("429: thrown by default; retry waits out Retry-After, within bounds", async () => {
  const t = await setup();
  await t.authorize("u1");
  const c = t.oc.connection("example", "u1");
  // The connection scope allows 2 per minute.
  expect((await c.fetch("a")).status).toBe(200);
  expect((await c.fetch("b")).status).toBe(200);
  const e = await rejects(c.fetch("c"));
  expect(e).toMatchObject({ code: "rate_limited", status: 429 });
  expect(e.retryAfterMs).toBeGreaterThan(0);
  expect(t.seen.length).toBe(2); // the provider never saw it

  // Over the wait budget: fails at once, no sleeping.
  expect(await rejects(c.fetch("c", { retry: { maxWaitMs: 1000 } }))).toMatchObject({ code: "rate_limited" });
  // A stream body can't be resent.
  expect(await rejects(c.fetch("c", { method: "POST", body: new Blob(["x"]).stream(), retry: true }))).toMatchObject({ code: "rate_limited" });
  expect(t.sleeps).toEqual([]);

  const ok = await c.fetch("c", { retry: true });
  expect(ok.status).toBe(200);
  expect(t.sleeps.length).toBe(1);
  expect(t.sleeps[0]).toBe(e.retryAfterMs!);
  expect(t.seen.map((r) => new URL(r.url).pathname)).toEqual(["/v1/a", "/v1/b", "/v1/c"]);
});

test("paths can't climb out of the proxy or the connection: raw, %2e%2e and %2E%2e", async () => {
  const t = await setup();
  await t.authorize("u1");
  await t.authorize("u2");
  const sent: string[] = [];
  const oc = connectd({ url: "https://oc.test", apiKey: "secret", fetch: (i, init) => (sent.push(i), t.rt.fetch(new Request(i, init), t.w.platform)) });
  const c = oc.connection("example", "u1");
  for (const p of ["../../../connections/example/u2/token", "%2e%2e/%2e%2e/%2e%2e/connections/example/u2/token", "%2E%2e/%2E%2E/u2/x", "a/../../x", "./.."])
    expect(await rejects(c.fetch(p, { method: "POST" }))).toMatchObject({ code: "bad_request", status: 400 });
  expect(await rejects(c.call(".."))).toMatchObject({ code: "bad_request" });
  for (const [d, i] of [["..", "x"], ["example", "."], ["example", ".."], ["", "x"]])
    expect(() => oc.connection(d!, i!)).toThrow(ConnectdError);
  expect(sent).toEqual([]); // nothing left the client

  // Inside the prefix is fine, and an id with dots in it is just an id.
  t.upstream((req) => new Response(new URL(req.url).pathname));
  expect(await (await c.fetch("a/../b")).text()).toBe("/v1/b");
  expect(await rejects(oc.connection("example", "..u1").status())).toMatchObject({ code: "not_found" });
});

test("the SDK imports no runtime code but signature.ts, which imports nothing", () => {
  const dir = new URL(".", import.meta.url).pathname;
  const imports = readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "testing.ts")
    .flatMap((f) => [...readFileSync(dir + f, "utf8").matchAll(/^(?:import|export)\s+(?!type\b)[^;]*?from\s+"([^"]+)"/gms)].map((m) => m[1]!));
  expect(imports.filter((s) => !s.startsWith("./"))).toEqual(["@kavishkagaya/connectd-runtime/signature", "@kavishkagaya/connectd-runtime/signature"]);
  const sig = readFileSync(new URL(import.meta.resolve("@kavishkagaya/connectd-runtime/signature")).pathname, "utf8");
  expect(sig).not.toMatch(/^\s*(import|export .* from)\b/m);
});
