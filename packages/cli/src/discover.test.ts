import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadProject } from "./load.ts";
import { resolve } from "./project.ts";

const TMP = join(import.meta.dir, "..", ".tmp-discover");
mkdirSync(TMP, { recursive: true });
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const CONFIG = (extra = "") => `
import { defineConfig } from "@openconnect/cli";
import { connection } from "@openconnect/connections";
export const listed = connection("listed").config().auth((f) => f.apiKey("key"));
export default defineConfig(() => ({ definitions: [listed]${extra} }));
`;

function project(files: Record<string, string>) {
  const dir = mkdtempSync(join(TMP, "p-"));
  for (const [f, src] of Object.entries(files)) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), src);
  }
  return dir;
}

test("folder discovery: connections and actions from connections/ and actions/ join the config; a registry is written", async () => {
  const dir = project({
    "openconnect.config.ts": CONFIG(),
    "connections/tracker.ts": `import { connection } from "@openconnect/connections";
export const tracker = connection("tracker").config().auth((f) => f.apiKey("key"));`,
    "actions/open.ts": `import { action } from "@openconnect/connections";
import { tracker } from "../connections/tracker.ts";
export const open = action("open", tracker).run(() => ({ ok: true }));
export const helper = 42;`,
    "actions/nested/close.ts": `import { action } from "@openconnect/connections";
import { tracker } from "../../connections/tracker.ts";
export const close = action("close", tracker).run(() => null);`,
    "actions/open.test.ts": "throw new Error('tests are not imported');",
  });
  const config = join(dir, "openconnect.config.ts");
  const r = await loadProject(dir, config, join(dir, ".openconnect", "build"), 1, {});
  expect(r.modules.map((m) => m.slice(dir.length + 1))).toEqual(["actions/nested/close.ts", "actions/open.ts", "connections/tracker.ts"]);
  expect(r.entry).toBe(join(dir, ".openconnect", "entry.ts"));
  const p = resolve(r.config, {});
  expect(p.definitions.map((d) => d.id)).toEqual(["listed", "tracker"]);
  expect(p.actions?.map((a) => a.id).sort()).toEqual(["close", "open"]);

  const reg = readFileSync(join(dir, ".openconnect", "registry.d.ts"), "utf8");
  expect(reg).toContain('import type config from "../openconnect.config.ts";');
  expect(reg).toContain('import type * as m2 from "../connections/tracker.ts";');
  expect(reg).toContain("interface Registry extends RegistryOf<typeof config, Exports<typeof m0 | typeof m1 | typeof m2>> {}");
});

test("no folders: the config runs as is, the registry still comes from it; named dirs must exist", async () => {
  const dir = project({ "openconnect.config.ts": CONFIG() });
  const config = join(dir, "openconnect.config.ts");
  const r = await loadProject(dir, config, join(dir, ".openconnect", "build"), 1, {});
  expect(r.entry).toBe(config);
  expect(existsSync(join(dir, ".openconnect", "entry.ts"))).toBe(false);
  expect(readFileSync(join(dir, ".openconnect", "registry.d.ts"), "utf8")).toContain("interface Registry extends RegistryOf<typeof config> {}");

  const named = project({ "openconnect.config.ts": CONFIG(', dirs: ["lib/oc"]') });
  await expect(loadProject(named, join(named, "openconnect.config.ts"), join(named, ".openconnect", "build"), 1, {})).rejects.toThrow("dirs: lib/oc is not a folder");
});
