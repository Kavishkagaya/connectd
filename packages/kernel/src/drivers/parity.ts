import type { AccountRow, ConnectionRow, Json, KeyRow, PasskeyRow, Platform, Program } from "../platform.ts";

/**
 * The behaviour every platform must show, in two suites: `parity` (an atom: store, versions, ttl,
 * timers, restarts) and `platformParity` (the deployment: atoms by name, destroy, limits, env,
 * defer, errors across a call, and every management db operation). Runner-agnostic: pass in
 * `test`/`expect` from bun:test or vitest. Time is relative (now() + ms) so platforms can start anywhere.
 * New platform behaviour goes here, never into one platform's own tests.
 */
export type World = {
  /** The platform the atoms run on (built with `PARITY_ENV` set, and the probe as the program). */
  platform: Platform;
  call(instance: string, method: string, args: Json): Promise<Json>;
  advance(ms: number): Promise<void>;
  /**
   * Stop and start again from what was stored, clock where it was. Only platforms whose state can be
   * lost in process (memory with a snapshot); a DO's storage is durable by construction.
   */
  restart?(): Promise<World> | World;
  /** Fault injection: make an atom unreachable (`Unavailable`) or reachable again. Platforms that can. */
  cut?(name: string, on: boolean): void;
  /** Wait for deferred work, where the platform can tell. */
  settle?(): Promise<void>;
};

/** What the parity platform's env holds. */
export const PARITY_ENV = { PARITY_VALUE: "parity" };

/** What a probe method that threw reports (errors thrown inside an atom are data here, so any platform can compare them). */
const caught = async (f: () => Promise<unknown>): Promise<Json> => {
  try {
    await f();
    return null;
  } catch (e) {
    return { error: e instanceof Error ? e.name : String(e) };
  }
};

/** A Program that exposes the raw atom and platform over onCall, and logs fired timers to its store. */
export const probe: Program = (d, p) => ({
  async onCall(method, args) {
    const a = (args ?? []) as Json[];
    const k = a[0] as string;
    switch (method) {
      case "id":
        return d.name;
      case "get":
        return d.store.get(k);
      case "put":
        await d.store.put(k, a[1] ?? null, a[2] === undefined ? undefined : { ttlMs: a[2] as number });
        return null;
      case "cas":
        return d.store.cas(k, a[1] as number | null, a[2] ?? null);
      case "take":
        return d.store.take(k);
      case "delete":
        await d.store.delete(k);
        return null;
      case "timer.set":
        await d.timer.set(k, d.now() + (a[1] as number), a[2] ?? null);
        return null;
      case "timer.cancel":
        await d.timer.cancel(k);
        return null;
      case "call":
        return p.atoms.call(k, a[1] as string, a[2] ?? null);
      case "fired":
        return ((await d.store.get("fired"))?.value ?? []) as Json;
      // Platform probes.
      // A value whose JSON is exactly `a[1]` bytes.
      case "try.put":
        return caught(() => d.store.put(k, "x".repeat((a[1] as number) - 2)));
      case "try.timer":
        return caught(() => d.timer.set(k, d.now() + 1000, "x".repeat((a[1] as number) - 2)));
      case "size": {
        const r = await d.store.get(k);
        return r ? JSON.stringify(r.value).length : null;
      }
      case "try.call":
        return caught(() => p.atoms.call(k, a[1] as string, a[2] ?? null));
      case "echo":
        return a[0] ?? null;
      // A result whose JSON is exactly `a[0]` bytes.
      case "big":
        return "x".repeat((a[0] as number) - 2);
      case "throw":
        throw new Error(`thrown in ${d.name}`);
      case "env":
        return p.env(k) ?? null;
      case "version":
        return p.version;
      case "limits":
        return p.limits;
      case "defer":
        p.defer(Promise.reject(new Error("deferred failure")));
        p.defer((async () => d.store.put("deferred", true))());
        return null;
    }
    throw new Error(`probe: unknown method ${method}`);
  },
  async onTimer(name, payload) {
    const fired = ((await d.store.get("fired"))?.value ?? []) as Json[];
    await d.store.put("fired", [...fired, [name, payload]]);
    if (name === "chain") await d.timer.set("chained", d.now(), null);
    if (name === "boom") throw new Error("boom");
  },
});

type Expect = (v: unknown) => { toBe(x: unknown): void; toEqual(x: unknown): void };
type Runner = { test: (n: string, fn: () => Promise<void>) => void; expect: Expect };

/** The atom: store, versions, ttl, timers, restarts. */
export function parity(name: string, world: () => Promise<World> | World, t: Runner) {
  const { test, expect } = t;

  test(`${name}: get, put, versions, delete`, async () => {
    const w = await world();
    expect(await w.call("a", "get", ["k"])).toBe(null);
    await w.call("a", "put", ["k", { x: 1 }]);
    const r1 = (await w.call("a", "get", ["k"])) as { v: number; value: Json };
    expect(r1.value).toEqual({ x: 1 });
    await w.call("a", "put", ["k", { x: 2 }]);
    const r2 = (await w.call("a", "get", ["k"])) as { v: number; value: Json };
    expect(r2.v > r1.v).toBe(true);
    await w.call("a", "delete", ["k"]);
    expect(await w.call("a", "get", ["k"])).toBe(null);
  });

  test(`${name}: cas, including no ABA after delete`, async () => {
    const w = await world();
    expect(await w.call("a", "cas", ["k", null, 1])).toBe(true);
    expect(await w.call("a", "cas", ["k", null, 2])).toBe(false);
    const { v } = (await w.call("a", "get", ["k"])) as { v: number };
    expect(await w.call("a", "cas", ["k", v, 2])).toBe(true);
    expect(await w.call("a", "cas", ["k", v, 3])).toBe(false);
    const { v: v2 } = (await w.call("a", "get", ["k"])) as { v: number };
    await w.call("a", "delete", ["k"]);
    await w.call("a", "put", ["k", 4]);
    expect(await w.call("a", "cas", ["k", v2, 5])).toBe(false);
    expect(((await w.call("a", "get", ["k"])) as { value: Json }).value).toBe(4);
  });

  test(`${name}: take is once`, async () => {
    const w = await world();
    await w.call("a", "put", ["k", "x"]);
    const both = await Promise.all([w.call("a", "take", ["k"]), w.call("a", "take", ["k"])]);
    expect(both.filter((x) => x === "x").length).toBe(1);
    expect(await w.call("a", "take", ["k"])).toBe(null);
  });

  test(`${name}: ttl`, async () => {
    const w = await world();
    await w.call("a", "put", ["k", 1, 1000]);
    await w.call("a", "put", ["j", 1, 1000]);
    await w.advance(999);
    expect(((await w.call("a", "get", ["k"])) as { value: Json }).value).toBe(1);
    await w.advance(1);
    expect(await w.call("a", "get", ["k"])).toBe(null);
    expect(await w.call("a", "take", ["j"])).toBe(null);
    expect(await w.call("a", "cas", ["k", null, 2])).toBe(true);
  });

  test(`${name}: timers fire in order, replace, cancel, survive errors`, async () => {
    const w = await world();
    await w.call("a", "timer.set", ["late", 300, "l"]);
    await w.call("a", "timer.set", ["boom", 50, null]);
    await w.call("a", "timer.set", ["first", 100, "f"]);
    await w.call("a", "timer.set", ["retry", 200, 1]);
    await w.call("a", "timer.set", ["retry", 150, 2]);
    await w.call("a", "timer.set", ["gone", 120, null]);
    await w.call("a", "timer.cancel", ["gone"]);
    await w.advance(99);
    expect(await w.call("a", "fired", [])).toEqual([["boom", null]]);
    await w.advance(151);
    expect(await w.call("a", "fired", [])).toEqual([["boom", null], ["first", "f"], ["retry", 2]]);
    await w.advance(50);
    expect(((await w.call("a", "fired", [])) as Json[]).at(-1)).toEqual(["late", "l"]);
  });

  test(`${name}: timer set while firing runs in the same advance`, async () => {
    const w = await world();
    await w.call("a", "timer.set", ["chain", 10, null]);
    await w.advance(10);
    expect(await w.call("a", "fired", [])).toEqual([["chain", null], ["chained", null]]);
  });

  test(`${name}: instances are isolated, call reaches the named one`, async () => {
    const w = await world();
    await w.call("a", "put", ["k", "a"]);
    expect(await w.call("b", "get", ["k"])).toBe(null);
    expect(await w.call("a", "call", ["b", "id", null])).toBe("b");
    await w.call("a", "call", ["b", "timer.set", ["t", 10, "via-a"]]);
    await w.advance(10);
    expect(await w.call("b", "fired", [])).toEqual([["t", "via-a"]]);
  });

  test(`${name}: a restart keeps state, versions, ttl and timers`, async () => {
    const first = await world();
    if (!first.restart) return;
    await first.call("a", "put", ["k", 1]);
    await first.call("a", "put", ["gone", 1]);
    await first.call("a", "delete", ["gone"]);
    await first.call("a", "put", ["ttl", 1, 50]);
    await first.call("a", "timer.set", ["t", 100, "p"]);
    const { v } = (await first.call("a", "get", ["k"])) as { v: number };
    const w = await first.restart();
    expect(((await w.call("a", "get", ["k"])) as { v: number }).v).toBe(v);
    expect(await w.call("a", "get", ["gone"])).toBe(null);
    await w.call("a", "put", ["j", 2]);
    expect(((await w.call("a", "get", ["j"])) as { v: number }).v > v).toBe(true);
    await w.advance(50);
    expect(await w.call("a", "get", ["ttl"])).toBe(null);
    expect(await w.call("a", "fired", [])).toEqual([]);
    await w.advance(50);
    expect(await w.call("a", "fired", [])).toEqual([["t", "p"]]);
  });
}

/** The error a promise rejects with, as `{ name, message }`; null when it resolves. */
async function rejection(p: Promise<unknown>): Promise<{ name: string; message: string } | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return e instanceof Error ? { name: e.name, message: e.message } : { name: "thrown", message: String(e) };
  }
}

/** The deployment: atoms by name, destroy, limits, env, version, defer, errors, and the management db. */
export function platformParity(name: string, world: () => Promise<World> | World, t: Runner) {
  const { test, expect } = t;

  test(`${name}: atoms are created on first use; what a handler throws reaches the caller`, async () => {
    const w = await world();
    expect(await w.platform.atoms.call("fresh", "id", null)).toBe("fresh");
    expect(await w.call("a", "call", ["b", "id", null])).toBe("b");
    const e = await rejection(w.platform.atoms.call("a", "throw", null));
    expect(e?.message.includes("thrown in a")).toBe(true);
  });

  test(`${name}: destroy wipes store and timers, keeps versions going up`, async () => {
    const w = await world();
    await w.call("a", "put", ["k", 1]);
    const { v } = (await w.call("a", "get", ["k"])) as { v: number };
    await w.call("a", "timer.set", ["t", 10, null]);
    await w.platform.atoms.destroy("a");
    await w.platform.atoms.destroy("never-used");
    expect(await w.call("a", "get", ["k"])).toBe(null);
    await w.advance(10);
    expect(await w.call("a", "fired", [])).toEqual([]);
    await w.call("a", "put", ["k", 2]);
    expect(((await w.call("a", "get", ["k"])) as { v: number }).v > v).toBe(true);
  });

  test(`${name}: limits are the same inside an atom and at the front door, and hold at the boundary`, async () => {
    const w = await world();
    const { valueBytes, callBytes } = w.platform.limits;
    expect(await w.call("a", "limits", [])).toEqual({ valueBytes, callBytes });
    // Values and timer payloads: exactly the limit fits, a byte more doesn't.
    expect(await w.call("a", "try.put", ["k", valueBytes])).toBe(null);
    expect(await w.call("a", "size", ["k"])).toBe(valueBytes);
    expect(await w.call("a", "try.put", ["j", valueBytes + 1])).toEqual({ error: "LimitExceeded" });
    expect(await w.call("a", "get", ["j"])).toBe(null);
    expect(await w.call("a", "try.timer", ["t", valueBytes])).toBe(null);
    expect(await w.call("a", "try.timer", ["u", valueBytes + 1])).toEqual({ error: "LimitExceeded" });
    // Call args (`["x…"]` is the string plus 4 bytes) and results, from the front door and from an atom.
    expect(await w.platform.atoms.call("a", "echo", ["x".repeat(callBytes - 4)])).toBe("x".repeat(callBytes - 4));
    expect((await rejection(w.platform.atoms.call("a", "echo", ["x".repeat(callBytes - 3)])))?.name).toBe("LimitExceeded");
    expect(((await w.platform.atoms.call("a", "big", [callBytes])) as string).length).toBe(callBytes - 2);
    expect((await rejection(w.platform.atoms.call("a", "big", [callBytes + 1])))?.name).toBe("LimitExceeded");
    expect(await w.call("a", "try.call", ["b", "big", [callBytes + 1]])).toEqual({ error: "LimitExceeded" });
  });

  test(`${name}: an unreachable atom throws Unavailable, to the front door and to other atoms`, async () => {
    const w = await world();
    if (!w.cut) return;
    w.cut("b", true);
    expect((await rejection(w.platform.atoms.call("b", "id", null)))?.name).toBe("Unavailable");
    expect(await w.call("a", "try.call", ["b", "id", null])).toEqual({ error: "Unavailable" });
    w.cut("b", false);
    expect(await w.call("a", "call", ["b", "id", null])).toBe("b");
  });

  test(`${name}: env, version`, async () => {
    const w = await world();
    expect(w.platform.env("PARITY_VALUE")).toBe("parity");
    expect(w.platform.env("PARITY_MISSING")).toBe(undefined);
    expect(await w.call("a", "env", ["PARITY_VALUE"])).toBe("parity");
    expect(await w.call("a", "env", ["PARITY_MISSING"])).toBe(null);
    expect(typeof w.platform.version === "string" && w.platform.version.length > 0).toBe(true);
    expect(await w.call("a", "version", [])).toBe(w.platform.version);
  });

  test(`${name}: deferred work runs; its failure is logged, not thrown`, async () => {
    const w = await world();
    expect(await w.call("a", "defer", [])).toBe(null);
    await w.settle?.();
    expect(((await w.call("a", "get", ["deferred"])) as { value: Json }).value).toBe(true);
  });

  const row = (def: string, id: string, version: number, o: Partial<ConnectionRow> = {}): Omit<ConnectionRow, "createdAt"> => ({
    def,
    id,
    state: "active",
    reason: null,
    external: {},
    updatedAt: 10,
    version,
    ...o,
  });
  const keys = (rows: { def: string; id: string }[]) => rows.map((r) => `${r.def}/${r.id}`);

  test(`${name}: db.connections: list order, filters, search, external lookup, pages`, async () => {
    const db = (await world()).platform.db.connections;
    await db.upsert(row("b", "x", 1));
    await db.upsert(row("a", "y", 1, { external: { team: "T1", user: "Alice" } }));
    await db.upsert(row("a", "x", 1, { external: { team: "T1" } }));
    await db.upsert(row("a", "z", 1, { external: { team: "T2" }, state: "revoked", reason: "user" }));

    const all = await db.list({});
    expect(keys(all.connections)).toEqual(["a/x", "a/y", "a/z", "b/x"]);
    expect(all.connections[0]).toEqual({ def: "a", id: "x", state: "active", reason: null, external: { team: "T1" }, createdAt: 10, updatedAt: 10, version: 1 });
    expect(all.cursor).toBe(null);

    expect(keys((await db.list({ def: "b" })).connections)).toEqual(["b/x"]);
    expect(keys((await db.list({ state: "revoked" })).connections)).toEqual(["a/z"]);
    expect(keys((await db.list({ q: "ALI" })).connections)).toEqual(["a/y"]);
    expect(keys((await db.list({ q: "y" })).connections)).toEqual(["a/y"]);
    expect(keys((await db.list({ def: "a", external: { key: "team", value: "T1" } })).connections)).toEqual(["a/x", "a/y"]);
    expect(keys(await db.byExternal("a", "team", "T1"))).toEqual(["a/x", "a/y"]);
    expect(await db.byExternal("b", "team", "T1")).toEqual([]);

    const p1 = await db.list({ limit: 3 });
    expect(keys(p1.connections)).toEqual(["a/x", "a/y", "a/z"]);
    const p2 = await db.list({ limit: 3, cursor: p1.cursor as string });
    expect(keys(p2.connections)).toEqual(["b/x"]);
    expect(p2.cursor).toBe(null);
    expect((await rejection(db.list({ cursor: "junk" })))?.name).toBe("BadCursor");
  });

  test(`${name}: db.connections: an older version never overwrites a newer row, its external ids included`, async () => {
    const db = (await world()).platform.db.connections;
    await db.upsert(row("a", "x", 5, { external: { team: "T1" } }));
    await db.upsert(row("a", "x", 4, { state: "revoked", external: { team: "T9" }, updatedAt: 20 }));
    expect((await db.list({})).connections).toEqual([{ def: "a", id: "x", state: "active", reason: null, external: { team: "T1" }, createdAt: 10, updatedAt: 10, version: 5 }]);
    expect(await db.byExternal("a", "team", "T9")).toEqual([]);
    // Equal or newer: replaced, external ids with it; createdAt stays.
    await db.upsert(row("a", "x", 5, { reason: "same version rewrites" }));
    await db.upsert(row("a", "x", 6, { state: "revoked", reason: "user", external: { team: "T2" }, updatedAt: 30 }));
    expect((await db.list({})).connections).toEqual([{ def: "a", id: "x", state: "revoked", reason: "user", external: { team: "T2" }, createdAt: 10, updatedAt: 30, version: 6 }]);
    expect(await db.byExternal("a", "team", "T1")).toEqual([]);
    expect(keys(await db.byExternal("a", "team", "T2"))).toEqual(["a/x"]);
  });
  const keyRow = (id: string, o: Partial<KeyRow> = {}): KeyRow => ({
    id,
    kind: "api",
    name: id,
    value: `v-${id}`,
    previous: null,
    previousUntil: null,
    createdAt: 10,
    rolledAt: null,
    revokedAt: null,
    lastUsedAt: null,
    ...o,
  });

  test(`${name}: db.keys: create, list, roll with and without a grace period, revoke, used`, async () => {
    const db = (await world()).platform.db.keys;
    expect(await db.create(keyRow("b", { createdAt: 20, kind: "events" }))).toBe(true);
    expect(await db.create(keyRow("a"))).toBe(true);
    expect(await db.create(keyRow("a", { name: "again" }))).toBe(false);
    expect((await db.list()).map((k) => k.id)).toEqual(["a", "b"]);
    expect(await db.get("b")).toEqual(keyRow("b", { createdAt: 20, kind: "events" }));
    expect(await db.get("none")).toBe(null);

    expect(await db.roll("a", "v2", 100, 50)).toEqual(keyRow("a", { value: "v2", previous: "v-a", previousUntil: 100, rolledAt: 50 }));
    // No grace (until <= at): the old value goes at once.
    expect(await db.roll("a", "v3", 60, 60)).toEqual(keyRow("a", { value: "v3", rolledAt: 60 }));
    expect(await db.roll("none", "v", 0, 0)).toBe(null);

    await db.used("a", 70);
    await db.used("a", 65);
    expect((await db.get("a"))?.lastUsedAt).toBe(70);

    expect(await db.revoke("a", 80)).toEqual(keyRow("a", { value: "v3", rolledAt: 60, lastUsedAt: 70, revokedAt: 80 }));
    expect(await db.revoke("a", 90)).toBe(null);
    expect(await db.roll("a", "v4", 0, 90)).toBe(null);
    expect((await db.get("a"))?.revokedAt).toBe(80);
  });

  test(`${name}: db.accounts and db.passkeys: create, password, sign out everywhere, delete takes the passkeys`, async () => {
    const { accounts, passkeys } = (await world()).platform.db;
    const acct = (username: string, o: Partial<AccountRow> = {}): AccountRow => ({ username, password: null, sessions: 0, createdAt: 10, ...o });
    expect(await accounts.create(acct("ann", { password: "h1" }))).toBe(true);
    expect(await accounts.create(acct("bob", { createdAt: 5 }))).toBe(true);
    expect(await accounts.create(acct("ann"))).toBe(false);
    expect((await accounts.list()).map((a) => a.username)).toEqual(["bob", "ann"]);
    expect(await accounts.password("ann", null)).toBe(true);
    expect(await accounts.password("none", "h")).toBe(false);
    expect(await accounts.signOut("ann")).toBe(1);
    expect(await accounts.signOut("ann")).toBe(2);
    expect(await accounts.signOut("none")).toBe(null);
    expect(await accounts.get("ann")).toEqual(acct("ann", { sessions: 2 }));

    const pk = (id: string, username: string, o: Partial<PasskeyRow> = {}): PasskeyRow => ({ id, username, publicKey: "spki", alg: -7, counter: 0, name: id, createdAt: 10, lastUsedAt: null, ...o });
    expect(await passkeys.add(pk("p2", "ann", { createdAt: 20 }))).toBe(true);
    expect(await passkeys.add(pk("p1", "ann"))).toBe(true);
    expect(await passkeys.add(pk("p3", "bob"))).toBe(true);
    expect(await passkeys.add(pk("p1", "bob"))).toBe(false);
    expect((await passkeys.list("ann")).map((p) => p.id)).toEqual(["p1", "p2"]);
    await passkeys.used("p1", 7, 30);
    expect(await passkeys.get("p1")).toEqual(pk("p1", "ann", { counter: 7, lastUsedAt: 30 }));
    expect(await passkeys.delete("p2")).toBe(true);
    expect(await passkeys.delete("p2")).toBe(false);

    expect(await accounts.delete("ann")).toBe(true);
    expect(await accounts.delete("ann")).toBe(false);
    expect(await accounts.get("ann")).toBe(null);
    expect(await passkeys.get("p1")).toBe(null);
    expect((await passkeys.list("bob")).map((p) => p.id)).toEqual(["p3"]);
  });

  test(`${name}: db.nonces: each claimed once until it expires`, async () => {
    const db = (await world()).platform.db.nonces;
    expect(await db.claim("n1", 100, 10)).toBe(true);
    expect(await db.claim("n1", 100, 50)).toBe(false);
    expect(await db.claim("n2", 60, 50)).toBe(true);
    // Past its expiry it's gone, so the same value could be claimed again (callers check expiry first).
    expect(await db.claim("n1", 200, 100)).toBe(true);
  });
}
