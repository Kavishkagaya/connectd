import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Config } from "./project.ts";

export const CONFIG_FILES = ["openconnect.config.ts", "openconnect.config.js", "openconnect.config.mjs"];

/** The config file's absolute path: `file` (relative to `dir`), else the first of CONFIG_FILES there. */
export function findConfig(dir: string, file?: string) {
  const f = file ?? CONFIG_FILES.find((c) => existsSync(join(dir, c)));
  if (!f || !existsSync(join(dir, f))) throw new Error(`no ${file ?? CONFIG_FILES[0]} in ${dir}`);
  return join(dir, f);
}

/** Bundle the config with its local imports into one file and import that, so every load sees fresh code. Packages stay external (one copy, so `instanceof` holds). */
export async function importConfig(entry: string, out: string, n: number): Promise<Config> {
  const r = await Bun.build({ entrypoints: [entry], target: "bun", packages: "external", outdir: out, naming: `config-${n}.js`, throw: false });
  if (!r.success) throw new Error(r.logs.map(String).join("\n") || "build failed");
  const file = r.outputs[0]?.path as string;
  try {
    const m = (await import(pathToFileURL(file).href)) as { default?: Config };
    if (!m.default) throw new Error(`${entry} has no default export (export default defineConfig({ definitions: [...] }))`);
    return m.default;
  } finally {
    rmSync(file, { force: true });
  }
}

