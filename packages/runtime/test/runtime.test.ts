import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, test } from "vitest";
import worker from "./worker.ts";

afterEach(() => reset()); // wipe DO storage and instances between tests

const req = async (method: string, path: string, body?: unknown) => {
  const r = new Request(`https://oc.test${path}`, {
    method,
    headers: { authorization: "Bearer secret" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const res = await worker.fetch(r, env as unknown as Record<string, unknown>);
  return { status: res.status, body: (await res.json()) as any };
};

test("cloudflare: connect, status, token and revoke through the Worker and the ConnectionDO", async () => {
  expect((await req("POST", "/connections/keyed/k1/connect", { key: "sk" })).body).toEqual({ url: null });
  expect((await req("GET", "/connections/keyed/k1")).body).toEqual({ state: "active", metadata: { account: "sk" } });
  expect((await req("POST", "/connections/keyed/k1/token")).body).toEqual({ kind: "static", fields: { key: "sk" } });
  expect((await req("POST", "/connections/keyed/k1/revoke")).body.state).toBe("revoked");
});

test("cloudflare: faults cross the DO boundary as data", async () => {
  const bad = await req("POST", "/connections/keyed/k2/connect", { key: "bad" });
  expect(bad.status).toBe(500);
  expect(bad.body.error).toMatchObject({ code: "error", message: "/me 401" });
  expect((await req("GET", "/connections/keyed/k2")).status).toBe(404); // the throw left no record
  expect((await req("POST", "/connections/keyed/k2/token")).body.error).toMatchObject({ code: "not_active", state: "missing" });
});
