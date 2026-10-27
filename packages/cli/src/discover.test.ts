import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findConfig, loadProject } from "./load.ts";
import { resolve } from "./project.ts";

const TMP = join(import.meta.dir, "..", ".tmp-discover");
mkdirSync(TMP, { recursive: true });
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const CONFIG = (extra = "") => `
import { defineConfig } from "@kavishkagaya/connectd";
import { connection } from "@kavishkagaya/connectd-connections";
export const listed = connection("listed").config().auth((f) => f.apiKey("key"));
export default defineConfig(() => ({ definitions: [listed]${extra} }));
`;
const KEYED = `import { connection } from "@kavishkagaya/connectd-connections";
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

test("connection folders: the folder names the connection, actions.ts maps its actions by name; entry and registry written", async () => {
  const dir = project({
    "oc.config.ts": CONFIG(),
    "src/oc/tracker/connection.ts": KEYED,
    // The key is the name: the file the action lives in means nothing (here \`opener.ts\` holds \`open\`).
    "src/oc/tracker/actions.ts": `import { action, actions } from "@kavishkagaya/connectd-connections";
import open from "./actions/opener.ts";
export default actions({ open, close: action({ run: () => null }) });`,
    "src/oc/tracker/actions/opener.ts": `import { action } from "@kavishkagaya/connectd-connections";
export default action({ run: () => ({ ok: true }) });`,
    "src/oc/tracker/events.ts": "throw new Error('the app side: never in the Worker');",
    // A connection with its own id (a provider's) runs as the folder's.
    "src/oc/gh/connection.ts": `import { connection } from "@kavishkagaya/connectd-connections";
export default connection("github").config().auth((f) => f.apiKey("token"));`,
    "src/oc/_shared/util.ts": "throw new Error('not a connection folder');",
  });
  const r = await load(dir);
  expect(r.found.map((f) => [f.id, f.actions && f.actions.slice(dir.length)])).toEqual([
    ["gh", null],
    ["tracker", "/src/oc/tracker/actions.ts"],
  ]);
  expect(r.entry).toBe(join(dir, ".connectd", "entry.ts"));
  const p = resolve(r.config, {});
  expect(p.definitions.map((d) => d.id)).toEqual(["listed", "gh", "tracker"]);
  expect(Object.keys(p.actions?.tracker ?? {}).sort()).toEqual(["close", "open"]);
  expect(p.registry.gh?.id).toBe("gh");

  const reg = readFileSync(join(dir, ".connectd", "registry.d.ts"), "utf8");
  expect(reg).toContain('import type config from "../oc.config.ts";');
  expect(reg).toContain('import type c1 from "../src/oc/tracker/connection.ts";');
  expect(reg).toContain('import type a1 from "../src/oc/tracker/actions.ts";');
  expect(reg).toContain('"tracker": Entry<typeof c1, typeof a1>;');
  expect(reg).toContain('"gh": Entry<typeof c0, {}>;');
  expect(reg).not.toContain("events");
  expect(readFileSync(r.entry, "utf8")).not.toContain("events");
  // The app's side: the folders with an events.ts, by id, imported without an extension.
  const app = readFileSync(join(dir, ".connectd", "app.ts"), "utf8");
  expect(app).toContain('import l1 from "../src/oc/tracker/events";');
  expect(app).toContain('export const listeners = { "tracker": l1 };');
});

test("no folders: the config runs as is; a named dir must exist", async () => {
  const dir = project({ "oc.config.ts": CONFIG() });
  const r = await load(dir);
  expect(r.entry).toBe(join(dir, "oc.config.ts"));
  expect(existsSync(join(dir, ".connectd", "entry.ts"))).toBe(false);
  expect(readFileSync(join(dir, ".connectd", "registry.d.ts"), "utf8")).toContain("interface Registry extends RegistryOf<typeof config> {");
  expect(readFileSync(join(dir, ".connectd", "app.ts"), "utf8")).toContain("export const listeners = {};");
  await expect(load(project({ "oc.config.ts": CONFIG(', dir: "lib/oc"') }))).rejects.toThrow("dir: lib/oc is not a folder");
});

test("refused: a folder without connection.ts, a bad folder or action name, a non-connection export, an id listed twice", async () => {
  await expect(load(project({ "oc.config.ts": CONFIG(), "oc/empty/actions.ts": "" }))).rejects.toThrow("no connection.ts");
  await expect(load(project({ "oc.config.ts": CONFIG(), "oc/a.b/connection.ts": KEYED }))).rejects.toThrow("letters, digits");
  // actions() checks its keys and values when the file loads; a plain object is checked by withFolders.
  const helper = `import { action, actions } from "@kavishkagaya/connectd-connections";`;
  await expect(load(project({ "oc.config.ts": CONFIG(), "oc/t/connection.ts": KEYED, "oc/t/actions.ts": `${helper} export default actions({ toString: action({ run: () => null }) });` }))).rejects.toThrow("toString: an action's name is reserved");
  await expect(load(project({ "oc.config.ts": CONFIG(), "oc/t/connection.ts": KEYED, "oc/t/actions.ts": `${helper} export default actions({ "a.b": action({ run: () => null }) });` }))).rejects.toThrow("letters, digits");
  const plain = project({ "oc.config.ts": CONFIG(), "oc/t/connection.ts": KEYED, "oc/t/actions.ts": "export default { run: 1 };" });
  await expect(load(plain).then((r) => resolve(r.config, {}))).rejects.toThrow("t/actions.ts: run: must be an action({ ... })");
  const none = project({ "oc.config.ts": CONFIG(), "oc/t/connection.ts": KEYED, "oc/t/actions.ts": "export const x = 1;" });
  // No default export: the bundler stops first, naming the file.
  await expect(load(none)).rejects.toThrow(/No matching export in .*oc\/t\/actions\.ts.* for import "default"/);
  await expect(load(project({ "oc.config.ts": CONFIG(), "oc/t/connection.ts": KEYED, "oc/t/actions.ts": "", "oc/t/actions.js": "" }))).rejects.toThrow("one actions file only");
  const notConn = project({ "oc.config.ts": CONFIG(), "oc/t/connection.ts": "export default 42;" });
  await expect(load(notConn).then((r) => resolve(r.config, {}))).rejects.toThrow("oc/t/connection.ts: the default export must be a connection");
  const twice = project({ "oc.config.ts": CONFIG(), "oc/listed/connection.ts": KEYED });
  await expect(load(twice).then((r) => resolve(r.config, {}))).rejects.toThrow("two connections with id listed");
  await expect(load(project({ "oc.config.ts": CONFIG(), "oc/constructor/connection.ts": KEYED }))).rejects.toThrow("constructor is reserved");
  await expect(load(project({ "oc.config.ts": CONFIG(), "oc/t/connection.ts": KEYED, "oc/t/connection.js": "export default 1;" }))).rejects.toThrow("one connection file only");
  const shadow = project({ "oc.config.ts": CONFIG(", actions: { t: {} }"), "oc/t/connection.ts": KEYED });
  await expect(load(shadow).then((r) => resolve(r.config, {}))).rejects.toThrow("actions for t are in the config");
});

test("upgrading from 0.2: action files named by file, without an actions.ts, fail loudly; helpers and tests in actions/ don't", async () => {
  const old = project({ "oc.config.ts": CONFIG(), "oc/t/connection.ts": KEYED, "oc/t/actions/open.ts": "export default 1;" });
  await expect(load(old)).rejects.toThrow("actions/: actions aren't named by their file any more. Add");
  // Only `_` helpers and tests: nothing to move.
  const helpers = project({ "oc.config.ts": CONFIG(), "oc/t/connection.ts": KEYED, "oc/t/actions/_shared.ts": "export const x = 1;", "oc/t/actions/x.test.ts": "" });
  expect((await load(helpers)).found[0]?.actions).toBeNull();
});

test("upgrading from the old layout fails loudly: connections/ and actions/ folders, connectd.config.ts", async () => {
  await expect(load(project({ "oc.config.ts": CONFIG(), "connections/notes.ts": KEYED }))).rejects.toThrow("connections/ next to oc.config.ts aren't read any more");
  const old = project({ "connectd.config.ts": CONFIG() });
  expect(() => findConfig(old)).toThrow("connectd.config.ts is now oc.config.ts");
});
