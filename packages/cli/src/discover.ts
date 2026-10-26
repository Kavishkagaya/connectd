import { createRequire } from "node:module";
import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { badActionName } from "@kavishkagaya/connectd-connections";
import type { Config, Env } from "./project.ts";
import { workdir } from "./workdir.ts";

/**
 * Connection folders (#54). Under the config's `dir`, one folder per connection, named by its id:
 *
 *   github/connection.ts          the connection (default export), required
 *   github/actions/<name>.ts      one action each (default export), named after the file
 *   github/events.ts              the app's handlers (#54, app side): never part of the Worker
 *
 * Three generated files in `.connectd/`, rebuilt by dev, deploy and `types`, never edited:
 *
 *   entry.ts         the config plus the folders (`withFolders`): what dev and deploy run
 *   registry.d.ts    `interface Registry` for @kavishkagaya/connectd/sdk, so `oc.connection("github", id)` is typed
 *   app.ts           the app's side: each folder's events.ts, for `connectd({ listeners })` in the app
 *
 * Node APIs only (fs, path), no Bun: deploy's plan runs it too.
 */

const DEFAULT_DIRS = ["src/oc", "oc"];
// ponytail: .ts, .js, .mjs only (no .mts/.cts/.tsx); symlinked folders aren't followed.
const EXTS = [".ts", ".js", ".mjs"];
const SKIP = /\.(test|spec|d)\.(ts|js|mjs)$/;
// The id ends up in URLs, instance keys and stored names.
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export type Found = { id: string; connection: string; actions: { name: string; file: string }[]; events: string | null };

const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();

/** The connection folders' parent, absolute: the config's `dir` (it must exist), else the first default that exists, else null. */
export function dirOf(config: Config, env: Env, configPath: string): string | null {
  const p = typeof config === "function" ? config(env) : config;
  const base = dirname(configPath);
  if (p?.dir === undefined) return DEFAULT_DIRS.map((d) => join(base, d)).find(isDir) ?? null;
  const abs = resolve(base, p.dir);
  if (!isDir(abs)) throw new Error(`dir: ${p.dir} is not a folder next to ${basename(configPath)}`);
  return abs;
}

/**
 * main-era layouts (`connections/`, `actions/` with named exports) aren't scanned any more: a
 * project that still has them would start without those connections, silently.
 */
export function oldLayout(configPath: string): string | null {
  const base = dirname(configPath);
  const old = ["connections", "actions"].filter((d) => isDir(join(base, d)));
  return old.length
    ? `${old.map((d) => `${d}/`).join(" and ")} next to ${basename(configPath)} aren't read any more: move each connection to <dir>/<id>/connection.ts (default export) and its actions to <dir>/<id>/actions/<name>.ts`
    : null;
}

/** Every connection folder under `dir`, sorted (stable output). Folders and action files starting with `.` or `_` are left out. */
export function foldersIn(dir: string | null): Found[] {
  if (!dir) return [];
  const out: Found[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!e.isDirectory() || /^[._]/.test(e.name) || e.name === "node_modules") continue;
    const at = join(dir, e.name);
    const shown = relative(process.cwd(), at) || at;
    if (!ID.test(e.name)) throw new Error(`${shown}: a connection folder's name is its id: letters, digits, _ and - only`);
    if (e.name in Object.prototype) throw new Error(`${shown}: ${e.name} is reserved; name the folder something else`);
    const files = EXTS.map((x) => join(at, `connection${x}`)).filter(existsSync);
    if (files.length > 1) throw new Error(`${shown}: one connection file only (found ${files.map((f) => basename(f)).join(", ")})`);
    const connection = files[0];
    if (!connection) throw new Error(`${shown}: no connection.ts (export default the connection, e.g. a provider)`);
    const actions: Found["actions"] = [];
    const adir = join(at, "actions");
    if (isDir(adir)) {
      for (const f of readdirSync(adir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const ext = EXTS.find((x) => f.name.endsWith(x));
        // `_` files are helpers the actions share, like `_` folders.
        if (!f.isFile() || !ext || SKIP.test(f.name) || /^[._]/.test(f.name)) continue;
        const name = f.name.slice(0, -ext.length);
        const bad = badActionName(name);
        if (bad) throw new Error(`${join(shown, "actions", f.name)}: the file name is the action's name, and it's ${bad}`);
        if (actions.some((a) => a.name === name)) throw new Error(`${join(shown, "actions")}: two files for action ${name}`);
        actions.push({ name, file: join(adir, f.name) });
      }
    }
    const ev = EXTS.map((x) => join(at, `events${x}`)).filter(existsSync);
    if (ev.length > 1) throw new Error(`${shown}: one events file only (found ${ev.map((f) => basename(f)).join(", ")})`);
    out.push({ id: e.name, connection, actions, events: ev[0] ?? null });
  }
  return out;
}

const spec = (from: string, to: string) => {
  const r = relative(from, to).split(sep).join("/");
  return JSON.stringify(r.startsWith(".") ? r : `./${r}`);
};

/**
 * Write `.connectd/entry.ts` (when there are folders) and `.connectd/registry.d.ts`. Returns
 * the entry to run: the generated one, or the config itself when there are no folders.
 */
export function writeDiscovered(dir: string, configPath: string, found: Found[]): { entry: string; registry: string; app: string } {
  const work = workdir(dir);
  const head = "// Generated by connectd (dev, deploy, types) from oc.config.ts and the connection folders; rebuilt each time, never edited.";
  const imports = (type: boolean) =>
    found.flatMap((f, i) => [
      `import ${type ? "type " : ""}c${i} from ${spec(work, f.connection)};`,
      ...f.actions.map((a, j) => `import ${type ? "type " : ""}a${i}_${j} from ${spec(work, a.file)};`),
    ]);
  const actions = (f: Found, i: number, type: boolean) =>
    f.actions.length ? `{ ${f.actions.map((a, j) => `${JSON.stringify(a.name)}: ${type ? "typeof " : ""}a${i}_${j}`).join(", ")} }` : "{}";

  const registry = join(work, "registry.d.ts");
  writeFileSync(
    registry,
    [
      head,
      "// Include it in the tsconfig of the app that uses @kavishkagaya/connectd/sdk.",
      `import type config from ${spec(work, configPath)};`,
      ...imports(true),
      `import type { ${found.length ? "Entry, " : ""}RegistryOf } from "@kavishkagaya/connectd/sdk";`,
      "",
      'declare module "@kavishkagaya/connectd/sdk" {',
      `  interface Registry extends RegistryOf<typeof config> {`,
      ...found.map((f, i) => `    ${JSON.stringify(f.id)}: Entry<typeof c${i}, ${actions(f, i, true)}>;`),
      "  }",
      "}",
      "",
    ].join("\n"),
  );

  // The app imports it (lib/oc.ts), so it's always there, and its imports carry no extension: the
  // app's bundler or tsconfig resolves them, like its own.
  const app = join(work, "app.ts");
  const listening = found.flatMap((f, i) => (f.events ? [{ f, i, file: f.events }] : []));
  writeFileSync(
    app,
    [
      head,
      "// The app's side: each folder's events.ts (listen()). Import it where you create the client:",
      '//   import { listeners } from "../.connectd/app"; export const oc = connectd({ user, listeners });',
      ...listening.map(({ i, file }) => `import l${i} from ${spec(work, file.replace(/\.(ts|js|mjs)$/, ""))};`),
      "",
      `export const listeners = ${listening.length ? `{ ${listening.map(({ f, i }) => `${JSON.stringify(f.id)}: l${i}`).join(", ")} }` : "{}"};`,
      "",
    ].join("\n"),
  );

  const entry = join(work, "entry.ts");
  if (!found.length) {
    rmSync(entry, { force: true });
    return { entry: configPath, registry, app };
  }
  writeFileSync(
    entry,
    [
      head,
      `import config from ${spec(work, configPath)};`,
      // By package name, like the config's own import: the bundle keeps packages external, resolved from the app.
      'import { withFolders } from "@kavishkagaya/connectd";',
      ...imports(false),
      "",
      "export default withFolders(config, [",
      ...found.map((f, i) => `  { id: ${JSON.stringify(f.id)}, file: ${JSON.stringify(relative(dir, f.connection).split(sep).join("/"))}, connection: c${i}, actions: ${actions(f, i, false)} },`),
      "]);",
      "",
    ].join("\n"),
  );
  return { entry, registry, app };
}

/**
 * A note when `@kavishkagaya/connectd/sdk` doesn't resolve from the project: the registry then types nothing
 * (its `declare module` augments a module TypeScript can't find). Null when it resolves.
 */
export function sdkNote(dir: string): string | null {
  try {
    createRequire(join(dir, "package.json")).resolve("@kavishkagaya/connectd/sdk");
    return null;
  } catch {
    return "note: @kavishkagaya/connectd isn't installed here, so .connectd/registry.d.ts types nothing; add it to the app's dependencies";
  }
}
