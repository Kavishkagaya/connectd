import { applyD1Migrations, type D1Migration, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, test } from "vitest";
import { findByExternal } from "../src/directory.ts";
import worker, { index } from "./worker.ts";

const e = env as unknown as { INDEX: D1Database; MIGRATIONS: D1Migration[] };
beforeEach(() => applyD1Migrations(e.INDEX, e.MIGRATIONS));
afterEach(() => reset()); // wipe DO storage, D1 and instances between tests

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

const ids = (b: { connections: { id: string }[] }) => b.connections.map((c) => c.id);

test("cloudflare: the DO keeps its D1 row current; list, filter, search, external lookup, pages", async () => {
  for (const [id, key] of [
    ["k1", "acct_a"],
    ["k2", "acct_b"],
    ["k3", "acct_a"],
  ])
    await req("POST", `/connections/keyed/${id}/connect`, { key });
  await req("POST", "/connections/keyed/k2/revoke", { reason: "user" });

  const all = await req("GET", "/connections");
  expect(ids(all.body)).toEqual(["k1", "k2", "k3"]);
  expect(all.body.connections[1]).toMatchObject({ def: "keyed", id: "k2", state: "revoked", reason: "user", external: { account: "acct_b" } });
  expect(ids((await req("GET", "/connections?state=active")).body)).toEqual(["k1", "k3"]);
  expect(ids((await req("GET", "/connections?q=CT_B")).body)).toEqual(["k2"]);
  expect(ids((await req("GET", "/connections?def=keyed&external=account:acct_a")).body)).toEqual(["k1", "k3"]);
  expect((await findByExternal(index, "keyed", "account", "acct_b")).map((r) => r.id)).toEqual(["k2"]);

  const p1 = await req("GET", "/connections?limit=2");
  expect(ids(p1.body)).toEqual(["k1", "k2"]);
  const p2 = await req("GET", `/connections?limit=2&cursor=${p1.body.cursor}`);
  expect(p2.body).toMatchObject({ cursor: null });
  expect(ids(p2.body)).toEqual(["k3"]);
});

test("cloudflare: D1 upserts are monotonic and move the external ids with the row", async () => {
  const row = { def: "d", id: "i", reason: null, updatedAt: 1 };
  await index.upsert({ ...row, state: "active", external: { team: "T2" }, version: 5 });
  await index.upsert({ ...row, state: "pending", external: { team: "T1" }, version: 3 }); // arrived late
  expect((await index.list({})).connections).toMatchObject([{ state: "active", external: { team: "T2" }, version: 5 }]);
  expect(await findByExternal(index, "d", "team", "T1")).toEqual([]);

  await index.upsert({ ...row, state: "active", external: { team: "T3" }, version: 7, updatedAt: 2 });
  expect(await findByExternal(index, "d", "team", "T2")).toEqual([]);
  expect(await findByExternal(index, "d", "team", "T3")).toMatchObject([{ id: "i", createdAt: 1, updatedAt: 2 }]);
});
