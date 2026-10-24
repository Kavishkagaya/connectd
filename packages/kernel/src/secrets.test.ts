import { expect, test } from "bun:test";
import { decrypt, encrypt, importHmacKey, importKeys, sign, verify } from "./secrets.ts";

const k = (n: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(n)));

test("secrets: encrypt/decrypt across key versions, signing", async () => {
  const v1 = await importKeys({ 1: k(1) }, 1);
  const v12 = await importKeys({ 1: k(1), 2: k(2) }, 2);
  const sealed = await encrypt("hi", v1);
  expect(await decrypt(sealed, v12)).toBe("hi");
  await expect(decrypt(await encrypt("hi", v12), v1)).rejects.toThrow();
  const hk = await importHmacKey(k(3));
  const s = await sign("payload", hk);
  expect(await verify(s, hk)).toBe("payload");
  expect(await verify(s.replace(/.$/, (c) => (c === "A" ? "B" : "A")), hk)).toBe(null);
  expect(await verify(`${s}.x`, hk)).toBe(null);
  expect(await verify("not base64!.@@@", hk)).toBe(null); // malformed input is null, not a throw
  expect(await verify(`${s.split(".")[0]}.%%%`, hk)).toBe(null);
});
