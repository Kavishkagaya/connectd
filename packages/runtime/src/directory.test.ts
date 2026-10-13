import { expect, test } from "bun:test";
import { apiKey, defineConnection } from "@openconnect/connections";
import { importHmacKey, importKeys, type Json } from "@openconnect/kernel";
import { memory } from "@openconnect/kernel/memory";
import { directory, findByExternal, type Index, memoryIndex, runtime } from "./index.ts";

const key = (n: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(n)));

// `team` stands in for Slack's teamId: several connections can share one.
const keyed = defineConnection({
  id: "keyed",
  auth: apiKey(["key", "team"]),
  metadata: async (_ctx, cred) => ({ team: cred.kind === "static" ? (cred.fields.team ?? "") : "" }),
  external: (m) => {
    if (externalFails) throw new Error("external blew up");
    return { team: m.team };
  },
});
let externalFails = false;
const plain = defineConnection({ id: "plain", auth: apiKey(["key"]) });

async function setup(index: Index = memoryIndex()) {
  const settings = {
    keys: await importKeys({ 1: key(1) }, 1),
    stateKey: await importHmacKey(key(9)),
    apiKey: "secret",
    redirectUri: "https://oc.test/callback",
    config: { keyed: null, plain: null },
  };
  const rt = runtime({ definitions: { keyed, plain }, settings: async () => settings, extensions: [directory(index)] });
  const w = memory(rt.program);
  const req = async (method: string, path: string, body?: Json, auth = "Bearer secret") => {
    const res = await rt.fetch(
      new Request(`https://oc.test${path}`, { method, headers: { authorization: auth }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
      w.call,
    );
    return { status: res.status, body: (await res.json()) as any };
  };
  return { index, w, req };
}

const ids = (b: { connections: { def: string; id: string }[] }) => b.connections.map((c) => `${c.def}/${c.id}`);

test("list, filter, search, external lookup and pagination", async () => {
  const { index, w, req } = await setup();
  await req("POST", "/connections/keyed/a1/connect", { key: "k", team: "T1" });
  await req("POST", "/connections/keyed/a2/connect", { key: "k", team: "T1" });
  await req("POST", "/connections/keyed/b1/connect", { key: "k", team: "T2" });
  await req("POST", "/connections/plain/p1/connect", { key: "k" });
  await req("POST", "/connections/keyed/zz/connect", { key: "k" }); // fails: nothing stored, nothing indexed

  const all = await req("GET", "/connections");
  expect(ids(all.body)).toEqual(["keyed/a1", "keyed/a2", "keyed/b1", "plain/p1"]);
  expect(all.body.connections[0]).toEqual({
    def: "keyed",
    id: "a1",
    state: "active",
    reason: null,
    external: { team: "T1" },
    createdAt: 0,
    updatedAt: 0,
    version: expect.any(Number),
  });
  expect(all.body.cursor).toBeNull();

  expect(ids((await req("GET", "/connections?def=plain")).body)).toEqual(["plain/p1"]);
  expect(ids((await req("GET", "/connections?q=t2")).body)).toEqual(["keyed/b1"]);
  expect(ids((await req("GET", "/connections?q=A")).body)).toEqual(["keyed/a1", "keyed/a2"]);
  expect(ids((await req("GET", "/connections?def=keyed&external=team:T1")).body)).toEqual(["keyed/a1", "keyed/a2"]);
  expect((await findByExternal(index, "keyed", "team", "T2")).map((r) => r.id)).toEqual(["b1"]);
  expect(await findByExternal(index, "plain", "team", "T2")).toEqual([]);

  const p1 = await req("GET", "/connections?limit=3");
  expect(ids(p1.body)).toEqual(["keyed/a1", "keyed/a2", "keyed/b1"]);
  const p2 = await req("GET", `/connections?limit=3&cursor=${p1.body.cursor}`);
  expect(ids(p2.body)).toEqual(["plain/p1"]);
  expect(p2.body.cursor).toBeNull();

  // Revoke and timers move state; the row follows.
  await w.advance(5000);
  expect((await req("POST", "/connections/keyed/a2/revoke", { reason: "user" })).body.state).toBe("revoked");
  const revoked = await req("GET", "/connections?state=revoked");
  expect(revoked.body.connections).toMatchObject([{ id: "a2", state: "revoked", reason: "user", createdAt: 0, updatedAt: 5000 }]);
  expect(ids((await req("GET", "/connections?state=active&def=keyed")).body)).toEqual(["keyed/a1", "keyed/b1"]);

  // The per-connection route still works next to the listing.
  expect((await req("GET", "/connections/keyed/a1")).body).toEqual({ state: "active", metadata: { team: "T1" } });
});

test("bad queries and the API key", async () => {
  const { req } = await setup();
  expect((await req("GET", "/connections", undefined, "Bearer nope")).status).toBe(401);
  expect((await req("POST", "/connections")).status).toBe(405);
  expect((await req("GET", "/connections?limit=0")).status).toBe(400);
  expect((await req("GET", "/connections?limit=x")).status).toBe(400);
  expect((await req("GET", "/connections?external=nocolon")).status).toBe(400);
  expect((await req("GET", "/connections?cursor=junk")).status).toBe(400);
});

test("upserts are monotonic: an older version never overwrites a newer row", async () => {
  const index = memoryIndex();
  const row = { def: "d", id: "i", reason: null, external: {} };
  await index.upsert({ ...row, state: "pending", updatedAt: 1, version: 1 });
  await index.upsert({ ...row, state: "revoked", updatedAt: 3, version: 3 });
  await index.upsert({ ...row, state: "active", updatedAt: 2, version: 2 }); // arrived late
  expect((await index.list({})).connections).toEqual([{ ...row, state: "revoked", createdAt: 1, updatedAt: 3, version: 3 }]);
});

test("a failed index write is retried on the next call; index.sync repairs a lost row", async () => {
  let rows = memoryIndex();
  let down = true;
  const flaky: Index = {
    upsert: async (r) => {
      if (down) throw new Error("d1 down");
      await rows.upsert(r);
    },
    list: (q) => rows.list(q),
  };
  const { req } = await setup(flaky);
  // The call itself doesn't fail: the DO is the source of truth.
  expect((await req("POST", "/connections/keyed/a1/connect", { key: "k", team: "T1" })).status).toBe(200);
  expect((await req("GET", "/connections")).body.connections).toEqual([]);
  down = false;
  await req("GET", "/connections/keyed/a1");
  expect(ids((await req("GET", "/connections")).body)).toEqual(["keyed/a1"]);

  // The database lost the row (wiped, restored from an old backup).
  rows = memoryIndex();
  await req("GET", "/connections/keyed/a1"); // unchanged connection: no write
  expect((await req("GET", "/connections")).body.connections).toEqual([]);
  expect((await req("POST", "/connections/keyed/a1/index.sync")).body).toBeNull();
  expect((await req("GET", "/connections?external=team:T1")).body.connections).toMatchObject([{ id: "a1", state: "active" }]);
});

test("a throwing external hook falls back to the last known ids; the row keeps tracking state", async () => {
  const { index, req } = await setup();
  await req("POST", "/connections/keyed/a1/connect", { key: "k", team: "T1" });
  externalFails = true;
  try {
    await req("POST", "/connections/keyed/a2/connect", { key: "k", team: "T2" }); // never had ids: {}
    expect((await req("POST", "/connections/keyed/a1/revoke")).body.state).toBe("revoked");
  } finally {
    externalFails = false;
  }
  expect((await index.list({})).connections).toMatchObject([
    { id: "a1", state: "revoked", external: { team: "T1" } },
    { id: "a2", state: "active", external: {} },
  ]);
});

test("writes only when what the index shows changes", async () => {
  const rows = memoryIndex();
  const writes: string[] = [];
  const { req } = await setup({ upsert: async (r) => (writes.push(`${r.id}:${r.state}`), rows.upsert(r)), list: (q) => rows.list(q) });
  await req("POST", "/connections/keyed/a1/connect", { key: "k", team: "T1" });
  await req("POST", "/connections/keyed/a1/token");
  await req("GET", "/connections/keyed/a1");
  // Re-auth with the same team: new record and metadata versions, the same row.
  await req("POST", "/connections/keyed/a1/connect", { key: "k2", team: "T1" });
  expect(writes).toEqual(["a1:active"]);
  // A new team is a change; so is revoke. Forced syncs always write.
  await req("POST", "/connections/keyed/a1/connect", { key: "k2", team: "T9" });
  await req("POST", "/connections/keyed/a1/revoke");
  await req("POST", "/connections/keyed/a1/index.sync");
  expect(writes).toEqual(["a1:active", "a1:active", "a1:revoked", "a1:revoked"]);
  expect((await rows.list({})).connections).toMatchObject([{ state: "revoked", external: { team: "T9" } }]);
});
