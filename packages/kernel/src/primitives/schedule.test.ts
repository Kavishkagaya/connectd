import { expect, test } from "bun:test";
import type { Json } from "../driver.ts";
import { memory } from "../drivers/memory.ts";
import { backoff, retry } from "./schedule.ts";

test("schedule: backoff bounds and retry payload", async () => {
  expect(backoff(0, {}, () => 0)).toBe(500);
  expect(backoff(0, {}, () => 1)).toBe(1000);
  expect(backoff(3, {}, () => 1)).toBe(8000);
  expect(backoff(30, { maxMs: 60_000 }, () => 0)).toBe(30_000);

  const fired: Json[] = [];
  const w = memory((d) => ({
    onCall: async () => retry(d, "t", 0, "job", { maxAttempts: 3 }),
    async onTimer(_n, p) {
      fired.push(p);
      await retry(d, "t", (p as { attempt: number }).attempt, "job", { maxAttempts: 3 });
    },
  }));
  expect(await w.call("x", "go", null)).toBe(true);
  for (let i = 0; i < 10; i++) await w.advance(10_000);
  expect(fired).toEqual([{ attempt: 1, data: "job" }, { attempt: 2, data: "job" }]);
});
