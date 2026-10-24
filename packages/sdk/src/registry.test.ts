import { expect, test } from "bun:test";
import { action, connection, hmacHex, type StandardSchemaV1, safeEqual } from "@openconnect/connections";
import { importHmacKey, importKeys, type Json } from "@openconnect/kernel";
import { memory } from "@openconnect/kernel/memory";
import { runtime, webhooks } from "@openconnect/runtime";
import { OpenConnectError, openconnect } from "./client.ts";
import type { RegistryOf } from "./registry.ts";

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
const open = action("open", tracker)
  .input(schema((v) => (typeof (v as { title?: unknown })?.title === "string" ? { title: (v as { title: string }).title } : null)))
  .run(async ({ api }, { title }) => ({ id: (await api.get<{ id: number }>(`/new?title=${encodeURIComponent(title)}`)).id }));
const me = action("me", tracker).run(async ({ identity }) => identity);
const config = () => ({ definitions: [tracker], actions: [open, me] });
type R = RegistryOf<typeof config>;

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
  const rt = runtime({ definitions: { tracker }, actions: [open, me], settings: async () => settings, extensions: [webhooks()] });
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
