import { applyD1Migrations, type D1Migration, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, test } from "vitest";
import { importHmacKey } from "@kavishkagaya/connectd/kernel";
import { ADMIN_TTL_MS, token } from "@kavishkagaya/connectd/runtime";
import worker from "connectd:generated";

const e = env as unknown as { INDEX: D1Database; MIGRATIONS: D1Migration[]; CONNECTD_ADMIN_KEY: string };
const ENV = env as unknown as Record<string, unknown>;
/** As `connectd keys` and `connectd dashboard` sign them: with the deployment's admin key. */
const signed = async (purpose: "admin" | "login") => token(await importHmacKey(e.CONNECTD_ADMIN_KEY), purpose, Date.now(), ADMIN_TTL_MS);

let key = "";
beforeEach(async () => {
  await applyD1Migrations(e.INDEX, e.MIGRATIONS);
  // The app's API key, made the way a first deploy makes it.
  const res = await worker.fetch(new Request("https://oc.test/admin/keys", { method: "POST", headers: { authorization: `Admin ${await signed("admin")}` }, body: JSON.stringify({ name: "app" }) }), ENV);
  expect(res.status).toBe(201);
  key = ((await res.json()) as { key: string }).key;
});
afterEach(() => reset());

const req = async (method: string, path: string, body?: unknown, headers: Record<string, string> = { authorization: `Bearer ${key}` }) => {
  const r = new Request(`https://oc.test${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return worker.fetch(r, ENV);
};
const json = async (method: string, path: string, body?: unknown) => (await req(method, path, body)).json() as Promise<any>;

test("the generated Worker: connect, status, list from D1, proxy, oauth redirect URI from the public URL", async () => {
  expect(await json("POST", "/connections/keyed/k1/connect", { key: "sk" })).toEqual({ url: null });
  expect(await json("GET", "/connections/keyed/k1")).toEqual({ state: "active", metadata: null });
  expect((await json("GET", "/connections?def=keyed")).connections.map((c: { id: string }) => c.id)).toEqual(["k1"]);
  expect(await json("GET", "/proxy/keyed/k1/things?x=1")).toEqual({ url: "https://upstream.test/v1/things?x=1&api_key=sk" });
  const { url } = await json("POST", "/connections/example/u1/connect");
  expect(new URL(url).searchParams.get("redirect_uri")).toBe("https://oc.test/callback");
  expect(new URL(url).searchParams.get("client_id")).toBe("cid");
  const envd = await json("POST", "/connections/envd/u1/connect");
  expect(new URL(envd.url).searchParams.get("client_id")).toBe("envd-cid");
  expect((await req("GET", "/connections/keyed/k1".replace("keyed", "nope"))).status).toBe(404);
  const anon = await worker.fetch(new Request("https://oc.test/connections/keyed/k1"), env as unknown as Record<string, unknown>);
  expect(anon.status).toBe(401);
});

test("the generated Worker serves the dashboard: the page, its script, and the API behind a session from a CLI link", async () => {
  const page = await worker.fetch(new Request("https://oc.test/dashboard"), env as unknown as Record<string, unknown>);
  expect(page.status).toBe(200);
  expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
  const src = /src="(\/dashboard\/app\.js\?v=[^"]+)"/.exec(await page.text())?.[1];
  const js = await worker.fetch(new Request(`https://oc.test${src}`), env as unknown as Record<string, unknown>);
  expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  expect((await js.text()).length).toBeGreaterThan(1000);
  const anon = await worker.fetch(new Request("https://oc.test/dashboard/api/overview"), env as unknown as Record<string, unknown>);
  expect(anon.status).toBe(401);
  // An API key isn't a session; a CLI link gives one.
  expect((await req("GET", "/dashboard/api/overview")).status).toBe(401);
  const login = await req("POST", "/dashboard/api/auth/login", { token: await signed("login") }, { origin: "https://oc.test" });
  expect(login.status).toBe(200);
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
  const ov = (await (await req("GET", "/dashboard/api/overview", undefined, { cookie })).json()) as any;
  expect(ov.callbackUrl).toBe("https://oc.test/callback");
  expect(ov.index).toBe(true);
  expect(ov.definitions.map((d: { id: string }) => d.id)).toEqual(["keyed", "example", "envd"]);
  await json("POST", "/connections/keyed/k1/connect", { key: "sk" });
  const d = (await (await req("GET", "/dashboard/api/connections/keyed/k1", undefined, { cookie })).json()) as any;
  expect(d.status.ok.state).toBe("active");
  expect(d.events.ok).toMatchObject({ enabled: false, pending: 0 });
  expect(d.webhooks.ok.supported).toBe(false);
});
