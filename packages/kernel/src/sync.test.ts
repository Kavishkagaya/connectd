import { expect, test } from "bun:test";
import { flight, flights, mutex } from "./sync.ts";

const tick = () => new Promise((r) => setTimeout(r, 1));

test("flight: callers at the same time share one run and its result", async () => {
  const f = flight<string>();
  let runs = 0;
  const job = async () => (runs++, await tick(), `token-${runs}`);
  expect(await Promise.all([f.run(job), f.run(job), f.run(job)])).toEqual(["token-1", "token-1", "token-1"]);
  expect(runs).toBe(1);
  expect(await f.run(job)).toBe("token-2"); // after it settled, a new run
});

test("flight: the error is shared, then the next caller starts fresh", async () => {
  const f = flight<string>();
  let runs = 0;
  const failing = async () => {
    runs++;
    await tick();
    throw new Error("provider down");
  };
  const all = await Promise.allSettled([f.run(failing), f.run(failing)]);
  expect(all.map((r) => r.status)).toEqual(["rejected", "rejected"]);
  expect(runs).toBe(1);
  expect(await f.run(async () => "ok")).toBe("ok");
  // A synchronous throw is a rejection too.
  await expect(
    f.run(() => {
      throw new Error("sync");
    }),
  ).rejects.toThrow("sync");
});

test("flights: one flight per key", async () => {
  const f = flights<"github" | "slack", string>();
  let runs = 0;
  const job = (v: string) => async () => (runs++, await tick(), v);
  const r = await Promise.all([f.run("github", job("g")), f.run("github", job("x")), f.run("slack", job("s"))]);
  expect(r).toEqual(["g", "g", "s"]);
  expect(runs).toBe(2);
});

test("mutex: one at a time, in arrival order, each with its own result; a failure releases it", async () => {
  const m = mutex();
  const log: string[] = [];
  let inside = 0;
  const job = (name: string, fail = false) => async () => {
    inside++;
    expect(inside).toBe(1);
    log.push(`${name}>`);
    await tick();
    log.push(`<${name}`);
    inside--;
    if (fail) throw new Error(name);
    return name;
  };
  const r = await Promise.allSettled([m.run(job("a")), m.run(job("b", true)), m.run(job("c"))]);
  expect(log).toEqual(["a>", "<a", "b>", "<b", "c>", "<c"]);
  expect(r.map((x) => (x.status === "fulfilled" ? x.value : "failed"))).toEqual(["a", "failed", "c"]);
});
