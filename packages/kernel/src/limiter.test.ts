import { expect, test } from "bun:test";
import type { Limiter } from "./limiter.ts";
import { world } from "./testkit.ts";

const S = 1000;

test("limiter: a burst of count, then one every period/count", async () => {
  const { w, get } = await world((k) => ({ k, own: k.limiter("proxy", { count: 2, periodMs: S }) }));
  const { k, own } = await get();
  expect(await k.acquire([own])).toEqual({ ok: true });
  expect(await k.acquire([own])).toEqual({ ok: true });
  expect(await k.acquire([own])).toEqual({ ok: false, retryAfterMs: 500 });
  await w.advance(500);
  expect(await k.acquire([own])).toEqual({ ok: true });
});

test("limiter: parallel acquires never over-grant", async () => {
  const { get } = await world((k) => ({ k, own: k.limiter("proxy", { count: 5, periodMs: S }) }));
  const { k, own } = await get();
  const r = await Promise.all(Array.from({ length: 12 }, () => k.acquire([own])));
  expect(r.filter((v) => v.ok)).toHaveLength(5);
});

test("limiter: all or nothing across instances; the other instance's kernel answers", async () => {
  const { get } = await world((k) => ({
    k,
    own: k.limiter("proxy", { count: 10, periodMs: S }),
    app: k.limiter.at("app:github", "proxy", { count: 1, periodMs: S }) as Limiter,
  }));
  const a = await get("conn:github:a");
  const b = await get("conn:github:b");
  expect(await a.k.acquire([a.own, a.app])).toEqual({ ok: true });
  // The app scope is used up: b is denied and its own permit is refunded.
  const v = await b.k.acquire([b.own, b.app]);
  expect(v.ok).toBe(false);
  for (let i = 0; i < 10; i++) expect(await b.k.acquire([b.own])).toEqual({ ok: true });
  // Refund the app permit: a can go again.
  await a.k.refund([a.app]);
  expect(await a.k.acquire([a.app])).toEqual({ ok: true });
});

test("limiter: observe only tightens", async () => {
  const { w, get } = await world((k) => ({ k, own: k.limiter("proxy", { count: 100, periodMs: S }) }));
  const { k, own } = await get();
  await own.observe({ remaining: 0, resetAt: 5000 });
  const v = await k.acquire([own]);
  expect(v.ok).toBe(false);
  await own.observe({ remaining: 50 }); // looser than what we hold: ignored
  expect((await k.acquire([own])).ok).toBe(false);
  await w.advance(5000);
  expect((await k.acquire([own])).ok).toBe(true);
});
