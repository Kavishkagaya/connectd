import { expect, test } from "bun:test";
import { type ActionCtx, action, connection, type StandardSchemaV1 } from "@kavishkagaya/connectd-connections";
import { fakeOAuth } from "@kavishkagaya/connectd-connections/testing";
import { importHmacKey, importKeys, type Json } from "@kavishkagaya/connectd-kernel";
import { memory } from "@kavishkagaya/connectd-kernel/memory";
import { type ConnectionEvent, events, runtime } from "./index.ts";

const MIN = 60_000;
const key = (n: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(n)));

/** A tiny Standard Schema: `{ repo: string }`. */
const repoSchema: StandardSchemaV1<{ repo: string }> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (v) =>
      typeof v === "object" && v !== null && typeof (v as { repo?: unknown }).repo === "string"
        ? { value: { repo: (v as { repo: string }).repo } }
        : { issues: [{ message: "Expected string", path: ["repo"] }] },
  },
};

const gh = connection("gh")
  .config<{ clientId: string; clientSecret: string }>()
  .auth((f) => f.oauth2({ authorizeUrl: "https://gh.test/authorize", tokenUrl: "https://gh.test/token" }))
  .api({ baseUrl: "https://api.gh.test" });
const bare = connection("bare")
  .config()
  .auth((f) => f.apiKey("key"));

let failing = 0;
const star = action({
  input: repoSchema,
  run: async ({ api, store }, { repo }) => {
    const res = await api.fetch(`/user/starred/${repo}`, { method: "PUT" });
    await store.set("last", repo);
    return { status: res.status };
  },
});
const last = action({ run: async ({ store, connection }) => ({ last: await store.get<string>("last"), id: connection.id, proto: await store.get("constructor") }) });
const forget = action({ run: async ({ store }) => void (await store.delete("last")) });
let hold: Promise<void> | null = null;
const sync = action({
  every: 10 * MIN,
  run: async ({ api, store }) => {
    if (failing > 0) {
      failing--;
      throw new Error("provider down");
    }
    if (hold) await hold;
    const n = ((await store.get<number>("runs")) ?? 0) + 1;
    await store.set("runs", n);
    return { n, user: (await api.get<{ login: string }>("/user")).login };
  },
});
const welcome = action({ on: "active", run: async ({ store }) => void (await store.set("welcomed", ((await store.get<number>("welcomed")) ?? 0) + 1)) });
const ping = action({ run: async ({ token }) => ({ kind: (await token()).kind }) });
const noApi = action({ run: async ({ api }) => (await api.get("/x")) as Json });

// Types: input actions take no triggers; an annotated conn is exact (bare has no .api()).
void (() => {
  // @ts-expect-error scheduled actions take no input
  action({ input: repoSchema, every: MIN, run: () => null });
  // @ts-expect-error bare has no .api()
  action({ run: async (conn: ActionCtx<typeof bare>) => conn.api.get("/x") });
});

async function setup() {
  const sent: ConnectionEvent[] = [];
  const p = fakeOAuth({
    tokenUrl: "https://gh.test/token",
    clientSecret: "cs",
    issue: (n) => ({ access_token: `a${n}`, refresh_token: `r${n}`, expires_in: 3600 }),
    error: () => ({ status: 400, body: { error: "invalid_grant" } }),
    route: async (url, req) => {
      if (url === "https://app.test/events") {
        sent.push((await req.json()) as ConnectionEvent);
        return new Response(null, { status: 204 });
      }
      const auth = req.headers.get("authorization");
      if (!auth?.startsWith("Bearer a")) return new Response(null, { status: 401 });
      if (url === "https://api.gh.test/user") return Response.json({ login: "octo" });
      if (url.startsWith("https://api.gh.test/user/starred/") && req.method === "PUT") return new Response(null, { status: 204 });
      return new Response(null, { status: 404 });
    },
  });
  const settings = {
    keys: await importKeys({ 1: key(1) }, 1),
    stateKey: await importHmacKey(key(9)),
    apiKey: "secret",
    redirectUri: "https://oc.test/callback",
    config: { gh: { clientId: "cid", clientSecret: "cs" }, bare: null },
    events: { url: "https://app.test/events", secret: `whsec_${key(3)}` },
  };
  const rt = runtime({ definitions: { gh, bare }, actions: { gh: { star, last, forget, sync, welcome }, bare: { ping, noApi } }, settings: async () => settings, extensions: [events()] });
  const w = memory(rt.program, { fetch: p.fetch });
  const req = async (path: string, body?: Json) => {
    const res = await rt.fetch(new Request(`https://oc.test${path}`, { method: "POST", headers: { authorization: "Bearer secret" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), w.platform);
    return { status: res.status, body: (await res.json()) as any };
  };
  const login = async (id: string) => {
    const c = await req(`/connections/gh/${id}/connect`);
    const back = p.approve(c.body.url);
    const res = await rt.fetch(new Request(`https://oc.test/callback?code=${back.code}&state=${encodeURIComponent(back.state)}`), w.platform);
    expect(res.status).toBe(200);
  };
  const store = async (id: string) => (await req(`/connections/gh/${id}/actions/last`)).body;
  const actionEvents = () => sent.filter((e) => /\.(completed|failed)$/.test(e.type)).map((e) => ({ type: e.type, ...(e.data as object) }) as Record<string, unknown>);
  return { w, req, login, store, actionEvents, p, sent };
}

test("actions over HTTP: input checked by its schema, run with an authed api, shared store, 409 when not active", async () => {
  const { req, login, store } = await setup();
  expect((await req("/connections/gh/u1/actions/star", { repo: "a/b" })).body.error).toMatchObject({ code: "not_active", status: 409 });
  await login("u1");

  const bad = await req("/connections/gh/u1/actions/star", { repo: 42 });
  expect(bad.status).toBe(400);
  expect(bad.body.error).toMatchObject({ code: "bad_request", issues: [{ message: "Expected string", path: ["repo"] }] });

  expect(await req("/connections/gh/u1/actions/star", { repo: "a/b" })).toEqual({ status: 200, body: { status: 204 } });
  expect(await store("u1")).toEqual({ last: "a/b", id: "u1", proto: null });
  // No body: the schema sees null.
  expect((await req("/connections/gh/u1/actions/star")).status).toBe(400);
  // The method name works too, and an unknown action is a 400 like any unknown method.
  expect((await req("/connections/gh/u1/actions.last")).body.last).toBe("a/b");
  expect((await req("/connections/gh/u1/actions/nope")).status).toBe(400);
  // Another connection has its own store.
  await login("u2");
  expect((await store("u2")).last).toBeNull();
  await req("/connections/gh/u1/actions/forget");
  expect((await store("u1")).last).toBeNull();

  // No api on a connection without one; the token is there.
  await req("/connections/bare/k1/connect", { key: "sk" });
  expect((await req("/connections/bare/k1/actions/ping")).body).toEqual({ kind: "static" });
  // No .api(): conn.api throws a clear error (a 500 from the action).
  expect(JSON.stringify((await req("/connections/bare/k1/actions/noApi")).body)).not.toContain("api.test");
});

test("every: runs while active, reports as events, retries a failure, stops on revoke; on: once per entry", async () => {
  const { w, req, login, actionEvents, p } = await setup();
  await login("u1");
  await w.advance(1); // the on("active") run, then the events drain
  await w.advance(1);
  expect(actionEvents()).toEqual([{ type: "welcome.completed", action: "welcome", trigger: "on", output: null }]);

  await w.advance(10 * MIN);
  await w.advance(1);
  expect(actionEvents().at(-1)).toEqual({ type: "sync.completed", action: "sync", trigger: "every", output: { n: 1, user: "octo" } });
  // actions.status: each action's trigger, and the next run of the scheduled ones (the dashboard reads it).
  const st = (await req("/connections/gh/u1/actions/status")).body as { id: string; every: number | null; on: string | null; next: number | null }[];
  expect(st.map((a) => [a.id, a.every, a.on])).toEqual([["star", null, null], ["last", null, null], ["forget", null, null], ["sync", 10 * MIN, null], ["welcome", null, "active"]]);
  expect(st.find((a) => a.id === "sync")?.next).toBeGreaterThan(w.now());

  // A failure is reported and retried (backoff), then the schedule goes on.
  failing = 1;
  await w.advance(10 * MIN);
  await w.advance(1);
  expect(actionEvents().at(-1)).toMatchObject({ type: "sync.failed", action: "sync", trigger: "every", error: "provider down", attempt: 1 });
  await w.advance(2 * MIN);
  await w.advance(1);
  expect(actionEvents().at(-1)).toMatchObject({ type: "sync.completed", action: "sync", output: { n: 2 } });

  // Revoked: no more runs.
  await req("/connections/gh/u1/revoke");
  const n = actionEvents().length;
  await w.advance(30 * MIN);
  await w.advance(30 * MIN);
  expect(actionEvents().length).toBe(n);
  // welcome ran once: the state never re-entered active.
  expect(actionEvents().filter((e) => e.action === "welcome").length).toBe(1);

  // on("active") runs again after a re-auth: a dead refresh token, then a new login.
  await login("u2");
  p.s.live.clear();
  await w.advance(60 * MIN); // the refresh fails: reauth_required
  expect((await req("/connections/gh/u2/status")).body.state).toBe("reauth_required");
  await login("u2");
  await w.advance(1);
  await w.advance(1);
  expect(actionEvents().filter((e) => e.action === "welcome").length).toBe(3);
});

test("revoked while a scheduled run is in flight: no failure reported, not armed again; unknown ids store nothing", async () => {
  const { w, req, login, actionEvents } = await setup();
  await login("u1");
  await w.advance(1);
  let release = () => {};
  hold = new Promise<void>((r) => (release = r));
  const run = w.advance(10 * MIN); // sync starts and waits
  await new Promise((r) => setTimeout(r, 5));
  await req("/connections/gh/u1/revoke");
  release();
  await run;
  hold = null;
  await w.advance(1);
  const after = actionEvents().filter((e) => e.action === "sync");
  // The run finished with the connection revoked (its api call refused): nothing failed, nothing re-armed.
  expect(after.filter((e) => String(e.type).endsWith(".failed"))).toEqual([]);
  const n = actionEvents().length;
  await w.advance(30 * MIN);
  expect(actionEvents().length).toBe(n);

  // A call for a connection that doesn't exist leaves no state behind.
  expect((await req("/connections/gh/ghost/status")).status).toBe(404);
  expect(Object.keys(w.dump()).filter((i) => i.includes("ghost"))).toEqual([]);
});

test("runtime refuses actions on a missing connection and unusable names; action() refuses input with triggers", () => {
  const settings = async () => ({}) as never;
  expect(() => runtime({ definitions: { bare }, actions: { gh: { star } }, settings })).toThrow("no connection gh");
  expect(() => runtime({ definitions: { gh }, actions: { gh: { "bad.id": star } }, settings })).toThrow("letters, digits");
  for (const n of ["then", "toJSON", "toString", "constructor"]) expect(() => runtime({ definitions: { gh }, actions: { gh: { [n]: star } }, settings })).toThrow("reserved");
  expect(() => action({ input: repoSchema, every: MIN, run: () => null } as never)).toThrow("no every or on");
  expect(() => action({ every: 10, run: () => null })).toThrow("at least 1000");
});
