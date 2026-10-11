import { expect, test } from "bun:test";
import type { Json } from "../driver.ts";
import { memory } from "../drivers/memory.ts";
import { acquire, handleRate, type Limit, observe, RATE, refund, type Scope } from "./rate.ts";

// Each instance routes RATE to handleRate; "go" runs a multi-scope op from that instance.
const world = () =>
  memory((d, self) => ({
    async onCall(method, args) {
      if (method === RATE) return handleRate(d, args);
      const { op, scopes, n, observed } = args as unknown as { op: string; scopes: Scope[]; n?: number; observed?: never };
      if (op === "acquire") return acquire(d, self, scopes, n) as unknown as Json;
      if (op === "refund") await refund(d, self, scopes, n);
      if (op === "observe") await observe(d, self, scopes[0]!, observed!);
      return null;
    },
    onTimer: async () => {},
  }));

const L: Limit = { count: 10, periodMs: 1000 };
const conn: Scope = { instance: "conn", key: "c", limit: L };
const app: Scope = { instance: "app", key: "github", limit: { count: 3, periodMs: 1000 } };
const go = (w: ReturnType<typeof world>, op: string, scopes: Scope[], extra: object = {}) =>
  w.call("conn", "go", { op, scopes, ...extra } as unknown as Json) as Promise<{ ok: boolean; retryAfterMs?: number }>;

test("burst of count, then one per period/count", async () => {
  const w = world();
  for (let i = 0; i < 10; i++) expect((await go(w, "acquire", [conn])).ok).toBe(true);
  expect(await go(w, "acquire", [conn])).toEqual({ ok: false, retryAfterMs: 100 });
  await w.advance(100);
  expect((await go(w, "acquire", [conn])).ok).toBe(true);
  expect((await go(w, "acquire", [conn])).ok).toBe(false);
  await w.advance(1000);
  for (let i = 0; i < 10; i++) expect((await go(w, "acquire", [conn])).ok).toBe(true);
});

test("concurrent acquires never over-admit", async () => {
  const w = world();
  const r = await Promise.all(Array.from({ length: 25 }, () => go(w, "acquire", [conn])));
  expect(r.filter((x) => x.ok).length).toBe(10);
});

test("multi-scope is all or nothing: a deny on app refunds conn", async () => {
  const w = world();
  for (let i = 0; i < 3; i++) expect((await go(w, "acquire", [conn, app])).ok).toBe(true);
  expect((await go(w, "acquire", [conn, app])).ok).toBe(false);
  // conn spent 3, not 4: 7 left.
  for (let i = 0; i < 7; i++) expect((await go(w, "acquire", [conn])).ok).toBe(true);
  expect((await go(w, "acquire", [conn])).ok).toBe(false);
});

test("refund gives capacity back", async () => {
  const w = world();
  for (let i = 0; i < 10; i++) await go(w, "acquire", [conn]);
  await go(w, "refund", [conn], { n: 2 });
  expect((await go(w, "acquire", [conn], { n: 2 })).ok).toBe(true);
  expect((await go(w, "acquire", [conn])).ok).toBe(false);
});

test("provider headers tighten the count", async () => {
  const w = world();
  await go(w, "observe", [conn], { observed: { retryAfterMs: 5000 } });
  expect(await go(w, "acquire", [conn])).toEqual({ ok: false, retryAfterMs: 5000 });
  await w.advance(5000);
  expect((await go(w, "acquire", [conn])).ok).toBe(true);

  const w2 = world();
  await go(w2, "observe", [conn], { observed: { remaining: 2 } });
  expect((await go(w2, "acquire", [conn], { n: 2 })).ok).toBe(true);
  expect((await go(w2, "acquire", [conn])).ok).toBe(false);

  const w3 = world();
  await go(w3, "observe", [conn], { observed: { remaining: 0, resetAt: w3.now() + 3000 } });
  expect(await go(w3, "acquire", [conn])).toEqual({ ok: false, retryAfterMs: 3000 });
});
