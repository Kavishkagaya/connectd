import { expect, test } from "bun:test";
import { backoff } from "./schedule.ts";

test("schedule: backoff bounds", () => {
  expect(backoff(0, {}, () => 0)).toBe(500);
  expect(backoff(0, {}, () => 1)).toBe(1000);
  expect(backoff(3, {}, () => 1)).toBe(8000);
  expect(backoff(30, { maxMs: 60_000 }, () => 0)).toBe(30_000);
});
