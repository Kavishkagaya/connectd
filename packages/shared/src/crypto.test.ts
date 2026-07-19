import { expect, test } from "bun:test";
import { decrypt, encrypt, importMasterKey } from "./crypto";

function randomKeyBase64(): string {
  const raw = crypto.getRandomValues(new Uint8Array(32));
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
  bytes[bytes.length - 1] ^= 0xff; // flip last byte of the GCM auth tag
  const tampered = btoa(String.fromCharCode(...bytes));

  await expect(decrypt(tampered, { 1: key })).rejects.toThrow();
});
