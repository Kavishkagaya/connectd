import { expect, test } from "bun:test";
import { world } from "./testkit.ts";

const quiet = async <T>(fn: () => Promise<T>) => {
  const err = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = err;
  }
};

test("timer: rings its handler with the payload; set replaces; cancel", async () => {
  const rang: { at: number; p: { hook: string } }[] = [];
  const { w, get } = await world((k) => ({
    t: k.timer<{ hook: string }>("renew", { handle: async (p) => void rang.push({ at: k.now(), p }) }),
  }));
  const { t } = await get();
  await t.set(100, { hook: "a" });
  await t.set(200, { hook: "b" }); // replaces
  await w.advance(150);
  expect(rang).toEqual([]);
  await w.advance(50);
  expect(rang).toEqual([{ at: 200, p: { hook: "b" } }]);
  await t.set(300, { hook: "c" });
  await t.cancel();
  await w.advance(1000);
  expect(rang).toHaveLength(1);
});

test("timer: throw = retry with growing waits, then giveUp; return = done", async () => {
  const tries: number[] = [];
  let gaveUp: unknown = null;
  const { w, get } = await world((k) => ({
    t: k.timer("refresh", {
      handle: async (_p, { attempt }) => {
        tries.push(attempt);
        throw new Error("provider down");
      },
      retry: { baseMs: 1000, maxAttempts: 3 },
      giveUp: async (_p, e) => void (gaveUp = (e as Error).message),
    }),
  }));
  const { t } = await get();
  await t.set(0);
  await quiet(async () => {
    for (let i = 0; i < 20; i++) await w.advance(500);
  });
  expect(tries).toEqual([0, 1, 2]); // maxAttempts counts the first try
  expect(gaveUp).toBe("provider down");
});

test("timer: the attempt count survives a restart", async () => {
  const tries: number[] = [];
  const setup = (fail: boolean) => (k: Parameters<Parameters<typeof world>[0]>[0]) => ({
    t: k.timer("refresh", {
      handle: async (_p: null, { attempt }: { attempt: number }) => {
        tries.push(attempt);
        if (fail) throw new Error("down");
      },
      retry: { baseMs: 1000, maxAttempts: 8 },
    }),
  });
  const a = await world(setup(true));
  await (await a.get()).t.set(0);
  await quiet(() => a.w.advance(0)); // attempt 0 fails, retry armed
  const b = await world(setup(false), { snapshot: a.w.dump() });
  await b.get();
  await b.w.advance(10_000);
  expect(tries).toEqual([0, 1]); // continued at attempt 1, not 0
});

test("timer: a recurring timer sets itself again", async () => {
  const at: number[] = [];
  const { w, get } = await world((k) => {
    const t = k.timer("sync", {
      handle: async () => {
        at.push(k.now());
        await t.set(k.now() + 100);
      },
    });
    return { t };
  });
  await (await get()).t.set(100);
  for (let i = 0; i < 3; i++) await w.advance(100);
  expect(at).toEqual([100, 200, 300]);
});
