import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { dirOf, type Found, foldersIn, oldLayout, writeDiscovered } from "./discover.ts";
import type { Config, Env } from "./project.ts";

export const CONFIG_FILES = ["oc.config.ts", "oc.config.js", "oc.config.mjs"];

/** The config file's absolute path: `file` (relative to `dir`), else the first of CONFIG_FILES there. */
export function findConfig(dir: string, file?: string) {
  const f = file ?? CONFIG_FILES.find((c) => existsSync(join(dir, c)));
  if (!f || !existsSync(join(dir, f))) {
    const renamed = !file && existsSync(join(dir, "openconnect.config.ts")) ? " (openconnect.config.ts is now oc.config.ts: rename it)" : "";
    throw new Error(`no ${file ?? CONFIG_FILES[0]} in ${dir}${renamed}`);
  }
  return join(dir, f);
}

/** Bundle the config with its local imports into one file and import that, so every load sees fresh code. Packages stay external (one copy, so `instanceof` holds). */
export async function importConfig(entry: string, out: string, n: number | string): Promise<Config> {
  const r = await Bun.build({ entrypoints: [entry], target: "bun", packages: "external", outdir: out, naming: `config-${n}.js`, throw: false });
  if (!r.success) throw new Error(r.logs.map(String).join("\n") || "build failed");
  const file = r.outputs[0]?.path as string;
  try {
    const m = (await import(pathToFileURL(file).href)) as { default?: Config };
    if (!m.default) throw new Error(`${entry} has no default export (export default defineConfig({ ... }))`);
    return m.default;
  } finally {
    rmSync(file, { force: true });
  }
}


/**
 * The config with its connection folders (#54): import it, scan its `dir`, write
 * `.openconnect/entry.ts` and `registry.d.ts`, and import the entry. `entry` is what a deploy
 * bundles (the config itself when there are no folders).
 */
export async function loadProject(dir: string, configPath: string, out: string, n: number, env: Env): Promise<{ config: Config; entry: string; found: Found[] }> {
  const base = await importConfig(configPath, out, n);
  const found = foldersIn(dirOf(base, env, configPath));
  const old = found.length ? null : oldLayout(configPath);
  if (old) throw new Error(old);
  const { entry } = writeDiscovered(dir, configPath, found);
  return { config: entry === configPath ? base : await importConfig(entry, out, `${n}-entry`), entry, found };
}
