import { expect, test } from "bun:test";
import { type ActionCtx, action, connection, type Definition, hmacHex, type StandardSchemaV1, safeEqual } from "@openconnect/connections";
import { importHmacKey, importKeys, type Json } from "@openconnect/kernel";
import { memory } from "@openconnect/kernel/memory";
import { events as eventsExt, runtime, webhooks } from "@openconnect/runtime";
import { type Client, type Connection, OpenConnectError, openconnect } from "./client.ts";
import type { Entry, RegistryOf } from "./registry.ts";

const key = (n: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(n)));
const schema = <T>(check: (v: unknown) => T | null): StandardSchemaV1<T> => ({
  "~standard": { version: 1, vendor: "test", validate: (v) => (check(v) === null ? { issues: [{ message: "invalid" }] } : { value: check(v) as T }) },
});
const repo = schema((v) => (typeof (v as { repo?: unknown })?.repo === "string" ? { repo: (v as { repo: string }).repo } : null));

// A project: one builder connection (api, identity, subscriptions), two actions, as discovery would find them.
const tracker = connection("tracker")
  .config()
  .auth((f) => f.apiKey("key"))
  .api({ baseUrl: "https://api.tracker.test", key: { header: "x-key" } })
  .identity(async ({ api }) => api.get<{ user: string }>("/me"))
  .webhooks({
    verify: async (_c, req, secret) => !!secret && safeEqual(req.headers.get("x-sig") ?? "", await hmacHex(secret, req.body)),
    parse: (req) => ({ topic: "issue", payload: JSON.parse(req.body) as Json }),
    subscription: repo,
    register: async (_ctx, _cred, _ep, input) => ({ hook: `hook:${input.repo}` }),
  });
const open = action({
  input: schema((v) => (typeof (v as { title?: unknown })?.title === "string" ? { title: (v as { title: string }).title } : null)),
  run: async ({ api }, { title }) => ({ id: (await api.get<{ id: number }>(`/new?title=${encodeURIComponent(title)}`)).id }),
});
const me = action({ run: async (conn: ActionCtx<typeof tracker>) => conn.identity });
// As the generated registry writes it for a `tracker/` folder.
type R = { tracker: Entry<typeof tracker, { open: typeof open; me: typeof me }> };

test("typed client: ids, actions (input and output), identity and subscriptions come from the registry", async () => {
  const settings = {
    keys: await importKeys({ 1: key(1) }, 1),
    stateKey: await importHmacKey(key(9)),
    apiKey: "secret",
    redirectUri: "https://oc.test/callback",
    config: { tracker: null },
    webhooks: { url: "https://oc.test/webhooks", key: await importHmacKey(key(5)) },
    fetch: (async (url: string, init?: RequestInit) => {
      if (new Headers(init?.headers).get("x-key") !== "k") return new Response(null, { status: 401 });
      if (url === "https://api.tracker.test/me") return Response.json({ user: "ada" });
      if (url.startsWith("https://api.tracker.test/new?title=")) return Response.json({ id: 7 });
      return new Response(null, { status: 404 });
    }) as typeof fetch,
  };
  const rt = runtime({ definitions: { tracker }, actions: { tracker: { open, me } }, settings: async () => settings, extensions: [webhooks()] });
  const w = memory(rt.program);
  const oc = openconnect<R>({ url: "https://oc.test", apiKey: "secret", fetch: (input, init) => rt.fetch(new Request(input, init), w.call) });

  const t = oc.connection("tracker", "u1");
  // @ts-expect-error not a connection of this project
  oc.connection("github", "u1");
  await t.connect({ key: "k" });

  const status = await t.status();
  const user: string | undefined = status.metadata?.user;
  expect(user).toBe("ada");

  const made = await t.actions.open({ title: "bug" });
  const id: number = made.id;
  expect(id).toBe(7);
  expect(await t.actions.me()).toEqual({ user: "ada" });
  // @ts-expect-error title must be a string
  await t.actions.open({ title: 1 }).catch(() => null);
  // @ts-expect-error no such action
  t.actions.close;
  // The server checks input too: a 400 with the schema's issues.
  const bad = await (t.actions.open as unknown as (i: Json) => Promise<Json>)({ title: 1 }).catch((e) => e);
  expect(bad).toBeInstanceOf(OpenConnectError);
  expect(bad.code).toBe("bad_request");

  const sub = await t.webhooks.subscribe({ repo: "o/r" });
  const r: string = sub.input.repo;
  expect(r).toBe("o/r");
  expect((await t.webhooks.list()).map((s) => s.id)).toEqual([sub.id]);
  // @ts-expect-error repo is required
  await t.webhooks.subscribe({}).catch(() => null);
  await t.webhooks.unsubscribe(sub.id);
  expect(await t.webhooks.list()).toEqual([]);

  // Not thenable: awaiting the actions object doesn't call an action named "then".
  expect(typeof (t.actions as { then?: unknown }).then).toBe("undefined");
});

test("untyped without a registry: any id, Json in and out", async () => {
  const oc = openconnect({ url: "https://oc.test", apiKey: "k", fetch: async () => Response.json({ ok: true }) });
  const c = oc.connection("anything", "x");
  const out: Json = await c.actions.whatever!({ a: 1 });
  expect(out).toEqual({ ok: true });
});

test("the actions proxy answers action names only: toJSON, toString and the like make no call", () => {
  let calls = 0;
  const oc = openconnect({ url: "https://oc.test", apiKey: "k", fetch: async () => (calls++, Response.json(null)) });
  const a = oc.connection("anything", "x").actions as Record<string, unknown>;
  for (const n of ["then", "toJSON", "toString", "valueOf", "constructor", "hasOwnProperty", "a.b", ""]) expect(a[n]).toBeUndefined();
  expect(JSON.stringify(a)).toBe("{}");
  expect(typeof a.star).toBe("function");
  expect(calls).toBe(0);
});

test("types: optional input stays optional, plain definitions widen the ids, typed connections fit the untyped Connection", () => {
  const opt = action({
    input: schema((v) => (v === undefined ? undefined : typeof v === "object" ? (v as { n?: number }) : null)) as StandardSchemaV1<{ n?: number } | undefined>,
    run: () => null,
  });
  const plain = { id: "plain" } as unknown as Definition<any, any>;
  // A config that lists its connections (and their actions) itself.
  type W = RegistryOf<() => { definitions: [typeof tracker, Definition<any, any>]; actions: { tracker: { opt: typeof opt } } }>;
  const oc = openconnect<W>({ url: "https://oc.test", apiKey: "k", fetch: async () => Response.json(null) });
  const t = oc.connection("tracker", "x");
  void (() => t.actions.opt());
  void (() => t.actions.opt({ n: 1 }));
  // Any id once a plain definition is listed; untyped (Json).
  const p = oc.connection("plain", "x");
  void (() => p.actions.whatever?.({ a: 1 }));
  // A typed connection where an untyped one is expected (event handlers, helpers).
  const typed = openconnect<R>({ url: "https://oc.test", apiKey: "k" }).connection("tracker", "x");
  const untyped: Connection = typed;
  const client: Client = oc as unknown as Client;
  expect([plain.id, typeof untyped.call, typeof client.connection]).toEqual(["plain", "function", "function"]);
});

// Typed events (#54): a connection with declared topics and its own events, an action that emits one.
const count = schema((v) => (typeof (v as { count?: unknown })?.count === "number" ? { count: (v as { count: number }).count } : null));
const board = connection("board")
  .config()
  .auth((f) => f.apiKey("key"))
  .webhooks({ verify: async () => true, parse: (req) => ({ topic: req.headers.get("x-topic") ?? "", payload: JSON.parse(req.body) as Json }), topics: ["card", "list"] })
  .events({ synced: count });
const sync = action({
  run: async (conn: ActionCtx<typeof board>) => {
    await conn.emit("synced", { count: 3 });
    // @ts-expect-error not one of board's events
    void (() => conn.emit("nope", {}));
    // @ts-expect-error the schema's input
    void (() => conn.emit("synced", { count: "3" }));
    return { done: true };
  },
});
const bad = action({ run: async (conn: ActionCtx) => (await conn.emit("synced", { count: "x" }), null) });
const unknown = action({ run: async (conn: ActionCtx) => (await conn.emit("missing"), null) });
const nightly = action({ every: 60_000, run: async (conn: ActionCtx<typeof board>) => (await conn.emit("synced", { count: 9 }), { swept: 2 }) });
// Emits, then throws: the app call fails and nothing it emitted is sent.
const broken = action({ run: async (conn: ActionCtx<typeof board>) => (await conn.emit("synced", { count: 1 }), (() => { throw new Error("broke"); })()) as null });
const plain = connection("plain").config().auth((f) => f.apiKey("key"));
void (() => {
  // @ts-expect-error plain declares no events
  action({ run: async (conn: ActionCtx<typeof plain>) => (await conn.emit("synced"), null) });
});
type B = { board: Entry<typeof board, { sync: typeof sync; nightly: typeof nightly; bad: typeof bad; unknown: typeof unknown; broken: typeof broken }> };

test("typed events: webhook.<topic> from the declared topics, <action>.completed, own events via conn.emit", async () => {
  const secret = `whsec_${key(3)}`;
  let deliver: (req: Request) => Promise<Response> = async () => new Response(null, { status: 204 });
  const settings = {
    keys: await importKeys({ 1: key(1) }, 1),
    stateKey: await importHmacKey(key(9)),
    apiKey: "secret",
    redirectUri: "https://oc.test/callback",
    config: { board: null },
    webhooks: { url: "https://oc.test/webhooks", key: await importHmacKey(key(5)) },
    events: { url: "https://app.test/events", secret },
    fetch: (async (url: string, init?: RequestInit) => (url === "https://app.test/events" ? deliver(new Request(url, init)) : new Response(null, { status: 404 }))) as typeof fetch,
  };
  const rt = runtime({ definitions: { board }, actions: { board: { sync, nightly, bad, unknown, broken } }, settings: async () => settings, extensions: [eventsExt(), webhooks()] });
  const w = memory(rt.program);
  const oc = openconnect<B>({ url: "https://oc.test", apiKey: "secret", fetch: (input, init) => rt.fetch(new Request(input, init), w.call) });
  const ev = oc.events({ secret, now: w.now });
  deliver = (req) => ev.handle(req);

  const seen: string[] = [];
  ev.on("connection.active", (e) => void seen.push(`${e.type} ${e.data.to} ${e.connection.definition satisfies "board"}`))
    .on("webhook.card", (e) => void seen.push(`${e.type} ${e.data.topic} ${JSON.stringify(e.data.payload)}`))
    .on("synced", (e) => void seen.push(`synced ${(e.data.count satisfies number) + 0}`))
    .on("sync.completed", (e) => void seen.push(`sync ${e.data.output.done satisfies boolean}`))
    .on("nightly.completed", (e) => void seen.push(`nightly ${e.data.output.swept satisfies number}`));
  void (() => {
    // @ts-expect-error not a declared topic
    ev.on("webhook.board", () => {});
    // @ts-expect-error no such action or event
    ev.on("missing.completed", () => {});
  });

  const b = oc.connection("board", "u1");
  await b.connect({ key: "k" });
  expect(await b.actions.sync()).toEqual({ done: true });
  // Checked against the schema, and against the names the connection declares: the app call fails.
  await expect(b.actions.bad()).rejects.toThrow();
  await expect(b.actions.unknown()).rejects.toThrow();
  await expect(b.actions.broken()).rejects.toThrow();
  const hook = (topic: string) =>
    rt.fetch(new Request("https://oc.test/webhooks/board/u1", { method: "POST", headers: { "x-topic": topic }, body: JSON.stringify({ n: 1 }) }), w.call).then((r) => r.json());
  expect(await hook("card")).toEqual({ delivered: 1 });
  // Not a declared topic: acknowledged, never an event.
  expect(await hook("board")).toEqual({ delivered: 0, ignored: "board" });
  await w.advance(60_000);
  await w.advance(1);
  // The scheduled run's own event goes out before its .completed.
  expect(seen).toEqual(["connection.active active board", "synced 3", 'webhook.card card {"n":1}', "synced 9", "nightly 2"]);
});
