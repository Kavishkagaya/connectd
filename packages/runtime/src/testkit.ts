import type { Platform } from "@kavishkagaya/connectd-kernel";
import { importKey } from "./access.ts";
import type { Settings } from "./host.ts";

/** For tests (not exported): an API key with a known secret, and the header that carries it. */
export const TEST_KEY = "ock_000000000000_secret";
export const BEARER = `Bearer ${TEST_KEY}`;

/** Seed the test API key, and `events` as the events secret. */
export async function seed(p: Platform, s: Pick<Settings, "keys">, events?: string) {
  await importKey(p, s.keys, "api", "test", TEST_KEY);
  if (events) await importKey(p, s.keys, "events", "test", events);
}
