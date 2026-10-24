import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findConfig, loadProject } from "./load.ts";
import { resolve } from "./project.ts";

const TMP = join(import.meta.dir, "..", ".tmp-discover");
mkdirSync(TMP, { recursive: true });
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const CONFIG = (extra = "") => `
import { defineConfig } from "@connectd/cli";
import { connection } from "@connectd/connections";
export const listed = connection("listed").config().auth((f) => f.apiKey("key"));
export default defineConfig(() => ({ definitions: [listed]${extra} }));
`;
const KEYED = `import { connection } from "@connectd/connections";
export default connection().config().auth((f) => f.apiKey("key"));`;

function project(files: Record<string, string>) {
  const dir = mkdtempSync(join(TMP, "p-"));
  for (const [f, src] of Object.entries(files)) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), src);
  }
  return dir;
}
const load = (dir: string) => loadProject(dir, join(dir, "oc.config.ts"), join(dir, ".connectd", "build"), 1, {});

test("connection folders: the folder names the connection, actions/<name>.ts its actions; entry and registry written", async () => {
  const dir = project({
    "oc.config.ts": CONFIG(),
    "src/oc/tracker/connection.ts": KEYED,
    "src/oc/tracker/actions/open.ts": `import { action } from "@connectd/connections";
export default action({ run: () => ({ ok: true }) });`,
    "src/oc/tracker/actions/close.ts": `import { action } from "@connectd/connections";
export default action({ run: () => null });`,
    "src/oc/tracker/actions/open.test.ts": "throw new Error('tests are not imported');",
    "src/oc/tracker/actions/_shared.ts": "export const helper = 1;",
    "src/oc/tracker/events.ts": "throw new Error('the app side: never in the Worker');",
    // A connection with its own id (a provider's) runs as the folder's.
    "src/oc/gh/connection.ts": `import { connection } from "@connectd/connections";
export default connection("github").config().auth((f) => f.apiKey("token"));`,
    "src/oc/_shared/util.ts": "throw new Error('not a connection folder');",
  });
  const r = await load(dir);
  expect(r.found.map((f) => [f.id, f.actions.map((a) => a.name)])).toEqual([
    ["gh", []],
    ["tracker", ["close", "open"]],
  ]);
  expect(r.entry).toBe(join(dir, ".connectd", "entry.ts"));
  const p = resolve(r.config, {});
  expect(p.definitions.map((d) => d.id)).toEqual(["listed", "gh", "tracker"]);
  expect(Object.keys(p.actions?.tracker ?? {}).sort()).toEqual(["close", "open"]);
  expect(p.registry.gh?.id).toBe("gh");

  const reg = readFileSync(join(dir, ".connectd", "registry.d.ts"), "utf8");
  expect(reg).toContain('import type config from "../oc.config.ts";');
  expect(reg).toContain('import type c1 from "../src/oc/tracker/connection.ts";');
  expect(reg).toContain('"tracker": Entry<typeof c1, { "close": typeof a1_0, "open": typeof a1_1 }>;');
  expect(reg).not.toContain("events.ts");
  expect(readFileSync(r.entry, "utf8")).not.toContain("events.ts");
});

test("no folders: the config runs as is; a named dir must exist", async () => {
  const dir = project({ "oc.config.ts": CONFIG() });
  const r = await load(dir);
  expect(r.entry).toBe(join(dir, "oc.config.ts"));
  expect(existsSync(join(dir, ".connectd", "entry.ts"))).toBe(false);
  expect(readFileSync(join(dir, ".connectd", "registry.d.ts"), "utf8")).toContain("interface Registry extends RegistryOf<typeof config> {");
  await expect(load(project({ "oc.config.ts": CONFIG(', dir: "lib/oc"') }))).rejects.toThrow("dir: lib/oc is not a folder");
});

test("refused: a folder without connection.ts, a bad folder or action name, a non-connection export, an id listed twice", async () => {
  await expect(load(project({ "oc.config.ts": CONFIG(), "oc/empty/actions/x.ts": "" }))).rejects.toThrow("no connection.ts");
  await expect(load(project({ "oc.config.ts": CONFIG(), "oc/a.b/connection.ts": KEYED }))).rejects.toThrow("letters, digits");
  await expect(load(project({ "oc.config.ts": CONFIG(), "oc/t/connection.ts": KEYED, "oc/t/actions/toString.ts": "" }))).rejects.toThrow("reserved");
  const notConn = project({ "oc.config.ts": CONFIG(), "oc/t/connection.ts": "export default 42;" });
  await expect(load(notConn).then((r) => resolve(r.config, {}))).rejects.toThrow("oc/t/connection.ts: the default export must be a connection");
  const twice = project({ "oc.config.ts": CONFIG(), "oc/listed/connection.ts": KEYED });
  await expect(load(twice).then((r) => resolve(r.config, {}))).rejects.toThrow("two connections with id listed");
  await expect(load(project({ "oc.config.ts": CONFIG(), "oc/constructor/connection.ts": KEYED }))).rejects.toThrow("constructor is reserved");
  await expect(load(project({ "oc.config.ts": CONFIG(), "oc/t/connection.ts": KEYED, "oc/t/connection.js": "export default 1;" }))).rejects.toThrow("one connection file only");
  const shadow = project({ "oc.config.ts": CONFIG(", actions: { t: {} }"), "oc/t/connection.ts": KEYED });
  await expect(load(shadow).then((r) => resolve(r.config, {}))).rejects.toThrow("actions for t are in the config");
});

test("upgrading from the old layout fails loudly: connections/ and actions/ folders, connectd.config.ts", async () => {
  await expect(load(project({ "oc.config.ts": CONFIG(), "connections/notes.ts": KEYED }))).rejects.toThrow("connections/ next to oc.config.ts aren't read any more");
  const old = project({ "connectd.config.ts": CONFIG() });
  expect(() => findConfig(old)).toThrow("connectd.config.ts is now oc.config.ts");
});
