import { importMasterKey, importSigningKey } from "@openconnect/shared";
import type { Env } from "./env";

/** Current key version new writes encrypt with. Bump when rotating; keep old versions in KEYS_BY_VERSION below. */
export const CURRENT_KEY_VERSION = 1;

export async function loadMasterKeys(
  env: Env
): Promise<{ current: CryptoKey; byVersion: Record<number, CryptoKey> }> {
  const v1 = await importMasterKey(env.MASTER_KEY_V1);
  // ponytail: single key version for now, add MASTER_KEY_V2 + a case here when rotating.
  return { current: v1, byVersion: { 1: v1 } };
}

export function loadStateSigningKey(env: Env): Promise<CryptoKey> {
  return importSigningKey(env.STATE_SIGNING_KEY);
}
