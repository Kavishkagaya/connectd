// Test harness for kernel v2 (not exported): instances on the memory driver, each running `setup`.
import type { Json, Program } from "../driver.ts";
import { memory, type Snapshot } from "../drivers/memory.ts";
import { importHmacKey, importKeys } from "../primitives/secrets.ts";
import { type Kernel, kernel, type Method } from "./kernel.ts";

const raw = (n: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(n)));
export const keys = async (versions: number[] = [1], current = Math.max(...versions)) =>
  importKeys(Object.fromEntries(versions.map((v) => [v, raw(v)])), current);
export const stateKey = () => importHmacKey(raw(9));

/** Each instance runs `setup(k)`; its result is reachable with `get(instance)`, its methods by `w.call`. */
export async function world<T>(
  setup: (k: Kernel) => T & { methods?: Record<string, Method> },
  o: { snapshot?: Snapshot; versions?: number[]; current?: number } = {},
) {
  const opts = { keys: await keys(o.versions, o.current), stateKey: await stateKey() };
  const made = new Map<string, T>();
  const program: Program = (d, instance) => {
    const k = kernel(d, { instance, ...opts });
    const t = setup(k);
    made.set(instance, t);
    return k.serve({ ...t.methods, "test.touch": async () => null });
  };
  const w = memory(program, o.snapshot ? { snapshot: o.snapshot } : {});
  const get = async (instance = "i") => {
    await w.call(instance, "test.touch", null);
    return made.get(instance)!;
  };
  return { w, get, opts, call: (instance: string, method: string, args: Json = null) => w.call(instance, method, args) };
}
