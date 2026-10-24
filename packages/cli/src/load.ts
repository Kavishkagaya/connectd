import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { dirOf, type Found, foldersIn, oldLayout, writeDiscovered } from "./discover.ts";
import type { Config, Env } from "./project.ts";

export const CONFIG_FILES = ["oc.config.ts", "oc.config.js", "oc.config.mjs"];

/** The config file's absolute path: `file` (relative to `dir`), else the first of CONFIG_FILES there. */
export function findConfig(dir: string, file?: string) {
  const f = file ?? CONFIG_FILES.find((c) => existsSync(join(dir, c)));
  if (!f || !existsSync(join(dir, f))) {
    const renamed = !file && existsSync(join(dir, "connectd.config.ts")) ? " (connectd.config.ts is now oc.config.ts: rename it)" : "";
    throw new Error(`no ${file ?? CONFIG_FILES[0]} in ${dir}${renamed}`);
  }
  return join(dir, f);
}

/**
 * Bundle the config with its local imports into one file and import that, so every load sees fresh
 * code. Packages stay external (one copy, so `instanceof` holds). esbuild, so Node runs it too; `.mjs`,
 * so a CommonJS project imports it as a module.
 */
export async function importConfig(entry: string, out: string, n: number | string): Promise<Config> {
  const file = join(out, `config-${n}.mjs`);
  try {
    await build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", packages: "external", outfile: file, logLevel: "silent" });
  } catch (e) {
    const errors = (e as { errors?: { text: string; location?: { file: string; line: number; column: number } | null }[] }).errors;
    throw new Error(errors?.map((x) => (x.location ? `${x.location.file}:${x.location.line}:${x.location.column}: ${x.text}` : x.text)).join("\n") || String(e));
  }
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
 * `.connectd/entry.ts` and `registry.d.ts`, and import the entry. `entry` is what a deploy
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
