import { expect, test } from "bun:test";
import { apiKey, defineConnection, oauth2 } from "@openconnect/connections";
import { fakeOAuth } from "@openconnect/connections/testing";
import { importHmacKey, importKeys, type Json, type OAuth2 } from "@openconnect/kernel";
import { memory } from "@openconnect/kernel/memory";
import { type Extension, runtime } from "./index.ts";

const H = 3_600_000;
const TOKEN = "https://example.test/token";
const key = (n: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(n)));

let meFails = false;
const example = defineConnection({
  id: "example",
  auth: oauth2<{ clientId: string; clientSecret: string }>({ authorizeUrl: "https://example.test/authorize", tokenUrl: TOKEN, scopes: ["read"] }),
  async metadata(ctx, cred) {
    if (meFails) throw new Error("user hook blew up");
    const res = await ctx.fetch("https://example.test/me", { headers: { authorization: `Bearer ${(cred as OAuth2).accessToken}` } });
    return (await res.json()) as { id: string };
  },
});
const keyed = defineConnection({ id: "keyed", auth: apiKey(["key"]) });

async function setup(extensions: Extension[] = []) {
  const p = fakeOAuth({
    tokenUrl: TOKEN,
    clientSecret: "cs",
    issue: (n) => ({ access_token: `a${n}`, refresh_token: `r${n}`, expires_in: 3600 }),
    error: () => ({ status: 400, body: { error: "invalid_grant" } }),
    route: () => Response.json({ id: "u1" }),
  });
  const settings = {
    keys: await importKeys({ 1: key(1) }, 1),
    stateKey: await importHmacKey(key(9)),
    apiKey: "secret",
    redirectUri: "https://oc.test/callback",
    config: { example: { clientId: "cid", clientSecret: "cs" }, keyed: null },
    fetch: p.fetch,
  };
  const rt = runtime({ definitions: { example, keyed }, settings: async () => settings, extensions });
  const w = memory(rt.program);
  const req = async (method: string, path: string, body?: Json, auth = "Bearer secret") => {
    const res = await rt.fetch(
      new Request(`https://oc.test${path}`, { method, headers: { authorization: auth }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
      w.call,
    );
    return { status: res.status, body: (await res.json()) as any };
  };
  return { p, w, req };
}

test("oauth2 over HTTP: connect, public callback, status, token, timer refresh, revoke", async () => {
  meFails = false;
  const { p, w, req } = await setup();
  const c = await req("POST", "/connections/example/c1/connect");
  expect(c.status).toBe(200);
  expect((await req("GET", "/connections/example/c1")).body).toEqual({ state: "pending", metadata: null });

  const back = p.approve(c.body.url);
  const cb = await req("GET", `/callback?code=${back.code}&state=${encodeURIComponent(back.state)}`, undefined, "");
  expect(cb).toEqual({ status: 200, body: { state: "active", metadata: { id: "u1" } } });
  expect((await req("POST", "/connections/example/c1/token")).body.accessToken).toBe("a1");

  await w.advance(H); // kernel.refresh timer, routed through the host
  expect((await req("POST", "/connections/example/c1/token")).body.accessToken).toBe("a2");

  expect((await req("POST", "/connections/example/c1/revoke", { reason: "user" })).body).toEqual({ state: "revoked", reason: "user", metadata: { id: "u1" } });
  const again = await req("POST", "/connections/example/c1/connect");
  expect(again.status).toBe(409);
  expect(again.body.error).toMatchObject({ code: "not_active", state: "revoked" });
});

test("errors come back as faults with a status; the API key guards everything but the callback", async () => {
  const { req } = await setup();
  expect((await req("GET", "/connections/example/c1", undefined, "Bearer nope")).status).toBe(401);
  expect((await req("GET", "/connections/example/c1")).body.error.code).toBe("not_found");
  expect((await req("GET", "/connections/nope/c1")).status).toBe(404);
  expect((await req("GET", "/nowhere")).status).toBe(404);
  expect((await req("POST", "/connections/example/c1/frobnicate")).status).toBe(400);
  expect((await req("POST", "/connections/example/c1/toString")).status).toBe(400);
  expect((await req("POST", "/connections/example/c1/kernel.rate", [])).status).toBe(404);
  expect((await req("GET", "/callback?state=forged", undefined, "")).status).toBe(400);
  expect((await req("POST", "/connections/keyed/k1/connect", { other: "x" })).status).toBe(400);
  expect((await req("POST", "/connections/keyed/k1/connect", [1])).status).toBe(400);
  expect((await req("POST", "/connections/keyed/k1/connect", { key: "sk" })).body).toEqual({ url: null });
  expect((await req("POST", "/connections/keyed/k1/token")).body).toEqual({ kind: "static", fields: { key: "sk" } });
});

test("a throwing definition hook is a 500 and leaves the record as it was", async () => {
  const { p, req } = await setup();
  const url = (await req("POST", "/connections/example/c1/connect")).body.url;
  meFails = true;
  const back = p.approve(url);
  const cb = await req("GET", `/callback?code=${back.code}&state=${encodeURIComponent(back.state)}`, undefined, "");
  expect(cb.status).toBe(500);
  expect(cb.body.error).toEqual({ code: "error", status: 500, message: "user hook blew up" });
  expect((await req("GET", "/connections/example/c1")).body.state).toBe("pending");

  // The handshake was single-use; a new connect works once the hook does.
  meFails = false;
  const again = p.approve((await req("POST", "/connections/example/c1/connect")).body.url);
  expect((await req("GET", `/callback?code=${again.code}&state=${encodeURIComponent(again.state)}`, undefined, "")).body.state).toBe("active");
});

test("extensions add routes, methods, timers and after hooks", async () => {
  const log: string[] = [];
  const ext: Extension = {
    routes: { hello: { public: true, fetch: async (_req, _api, path) => Response.json({ hello: path }) } },
    connection: ({ d, id }) => ({
      methods: {
        ping: async () => {
          await d.timer.set("ext.tick", d.now() + 1000);
          return id;
        },
        connect: async () => "shadowed",
      },
      onTimer: async (name) => name === "ext.tick" && (log.push("tick"), true),
      after: async (cause) => void log.push(cause),
    }),
  };
  const { w, req } = await setup([ext]);
  expect((await req("GET", "/hello/a/b", undefined, "")).body).toEqual({ hello: ["a", "b"] });
  expect((await req("POST", "/connections/keyed/k1/ping")).body).toBe("k1");
  expect((await req("POST", "/connections/keyed/k1/connect", { key: "sk" })).body).toEqual({ url: null });
  await w.advance(1000);
  expect(log).toEqual(["ping", "connect", "tick", "ext.tick"]);
});
