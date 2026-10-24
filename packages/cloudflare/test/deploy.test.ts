import { applyD1Migrations, type D1Migration, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, test } from "vitest";
import worker from "openconnect:generated";

const e = env as unknown as { INDEX: D1Database; MIGRATIONS: D1Migration[] };
beforeEach(() => applyD1Migrations(e.INDEX, e.MIGRATIONS));
afterEach(() => reset());

const req = async (method: string, path: string, body?: unknown) => {
  const r = new Request(`https://oc.test${path}`, { method, headers: { authorization: "Bearer test-key" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return worker.fetch(r, env as unknown as Record<string, unknown>);
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

test("the generated Worker serves the dashboard: the page, its script, and the API behind the key", async () => {
  const page = await worker.fetch(new Request("https://oc.test/dashboard"), env as unknown as Record<string, unknown>);
  expect(page.status).toBe(200);
  expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
  const src = /src="(\/dashboard\/app\.js\?v=[^"]+)"/.exec(await page.text())?.[1];
  const js = await worker.fetch(new Request(`https://oc.test${src}`), env as unknown as Record<string, unknown>);
  expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  expect((await js.text()).length).toBeGreaterThan(1000);
  const anon = await worker.fetch(new Request("https://oc.test/dashboard/api/overview"), env as unknown as Record<string, unknown>);
  expect(anon.status).toBe(401);
  const ov = await json("GET", "/dashboard/api/overview");
  expect(ov.callbackUrl).toBe("https://oc.test/callback");
  expect(ov.index).toBe(true);
  expect(ov.definitions.map((d: { id: string }) => d.id)).toEqual(["keyed", "example", "envd"]);
  await json("POST", "/connections/keyed/k1/connect", { key: "sk" });
  const d = await json("GET", "/dashboard/api/connections/keyed/k1");
  expect(d.status.ok.state).toBe("active");
  expect(d.events.ok).toMatchObject({ enabled: false, pending: 0 });
  expect(d.webhooks.ok.supported).toBe(false);
});
