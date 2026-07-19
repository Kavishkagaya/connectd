import { expect, test } from "bun:test";
import {
  decrypt,
  encrypt,
  importMasterKey,
  importSigningKey,
  signState,
  verifyState,
} from "./crypto";

const KEY_BYTES = 32;
const BYTE_MODULUS = 256;

function randomKeyBase64(): string {
  const raw = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  return btoa(String.fromCharCode(...raw));
}

test("round-trips plaintext through encrypt/decrypt", async () => {
  const key = await importMasterKey(randomKeyBase64());
  const packed = await encrypt("xoxb-super-secret-token", key, 1);

  expect(packed).not.toContain("xoxb-super-secret-token");
  expect(await decrypt(packed, { 1: key })).toBe("xoxb-super-secret-token");
});

test("supports multiple key versions at once, for rotation", async () => {
  const keyV1 = await importMasterKey(randomKeyBase64());
  const keyV2 = await importMasterKey(randomKeyBase64());

  const oldPacked = await encrypt("old-secret", keyV1, 1);
  const newPacked = await encrypt("new-secret", keyV2, 2);
  const keysByVersion = { 1: keyV1, 2: keyV2 };

  expect(await decrypt(oldPacked, keysByVersion)).toBe("old-secret");
  expect(await decrypt(newPacked, keysByVersion)).toBe("new-secret");
});

test("fails decryption if ciphertext is tampered with", async () => {
  const key = await importMasterKey(randomKeyBase64());
  const packed = await encrypt("do-not-tamper", key, 1);
  const bytes = Uint8Array.from(atob(packed), (c) => c.charCodeAt(0));
  const lastByteIndex = bytes.length - 1;
  bytes[lastByteIndex] = ((bytes[lastByteIndex] ?? 0) + 1) % BYTE_MODULUS; // corrupt the GCM auth tag
  const tampered = btoa(String.fromCharCode(...bytes));

  await expect(decrypt(tampered, { 1: key })).rejects.toThrow();
});

test("signState/verifyState round-trips and rejects tampering", async () => {
  const key = await importSigningKey(randomKeyBase64());
  const state = await signState("team:slack:T0123", key);

  expect(await verifyState(state, key)).toBe("team:slack:T0123");
  expect(await verifyState(`${state}x`, key)).toBeNull();

  const otherKey = await importSigningKey(randomKeyBase64());
  expect(await verifyState(state, otherKey)).toBeNull();
});
