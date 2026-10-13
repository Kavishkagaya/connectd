import { expect, test } from "bun:test";
import { memory } from "../drivers/memory.ts";
import { decrypt, encrypt, importHmacKey, importKeys, secrets, sign, verify } from "./secrets.ts";

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

test("secrets store: rotation re-seals on read, then the old key can go", async () => {
  const v1 = await importKeys({ 1: k(1) }, 1);
  const v12 = await importKeys({ 1: k(1), 2: k(2) }, 2);
  const v2 = await importKeys({ 2: k(2) }, 2);
  const w = memory((d) => ({
    async onCall(m, a) {
      const [keys, op] = m.split(":") as [string, string];
      const s = secrets(d, { v1, v12, v2 }[keys]!);
      if (op === "get") return s.get("client");
      await s.put("client", a);
      return null;
    },
    onTimer: async () => {},
  }));
  await w.call("t", "v1:put", { secret: "x" });
  await expect(w.call("t", "v2:get", null)).rejects.toThrow();
  expect(await w.call("t", "v12:get", null)).toEqual({ secret: "x" });
  expect(await w.call("t", "v2:get", null)).toEqual({ secret: "x" });
});
