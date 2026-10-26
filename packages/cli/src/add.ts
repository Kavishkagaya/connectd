import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { dirOf } from "./discover.ts";
import { parseEnv } from "./env.ts";
import { findConfig, importConfig } from "./load.ts";
import { type Template, TEMPLATES, template } from "./templates.ts";
import { workdir } from "./workdir.ts";

/**
 * `connectd add <provider>` and `connectd diff <id>` (#54, shadcn style). A provider is copied into
 * the project as source, `<dir>/<id>/connection.ts`, and is then the app's to edit: no
 * `@kavishkagaya/connectd-providers` dependency, only `@kavishkagaya/connectd/connections`. The catalog is `registry/` in the
 * connectd repo (`registry/<provider>.json`), fetched at this CLI's version tag (`main` while
 * unreleased); `--registry <url or folder>` or `CONNECTD_REGISTRY` points elsewhere.
 */

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const REPO = "https://raw.githubusercontent.com/Kavishkagaya/connectd";
const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** The first line of a copied file: where it came from, so `diff` knows what to compare with. */
const HEADER = /^\/\/ connectd: ([A-Za-z0-9_-]+)@(\S+?)\.?(?: |$)/;

type Entry = { id: string; version: string; description: string; env: string[]; optionalEnv: string[]; files: Record<string, string> };
type Listed = Pick<Entry, "id" | "version" | "description">;

export type AddOptions = {
  dir: string;
  config?: string;
  /** Where the catalog is: a base URL or a folder. Default: CONNECTD_REGISTRY, else the repo at this version's tag. */
  registry?: string;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
  fetch?: typeof fetch;
};

export const registryOf = (o: Pick<AddOptions, "registry" | "env">) =>
  o.registry ?? o.env?.CONNECTD_REGISTRY ?? `${REPO}/${pkg.version === "0.0.0" ? "main" : `v${pkg.version}`}/registry`;

async function read<T>(o: AddOptions, name: string): Promise<T> {
  const base = registryOf(o);
  if (/^https?:\/\//.test(base)) {
    const url = `${base.replace(/\/+$/, "")}/${name}`;
    const res = await (o.fetch ?? fetch)(url);
    if (res.status === 404) throw new Error(`${name.replace(/\.json$/, "")} isn't in the catalog (${url}); \`connectd add\` lists it`);
    if (!res.ok) throw new Error(`fetching ${url}: HTTP ${res.status}`);
    return json<T>(await res.text(), url);
  }
  const file = resolve(o.dir, base, name);
  if (!existsSync(file)) throw new Error(`${name.replace(/\.json$/, "")} isn't in the catalog (${file}); \`connectd add\` lists it`);
  return json<T>(readFileSync(file, "utf8"), file);
}

function json<T>(text: string, from: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${from} isn't JSON`);
  }
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** An entry as the catalog must shape it: a connection.ts, env names that are names (they go into .env as lines). */
function checked(e: Entry, from: string): Entry {
  const names = (v: unknown) => Array.isArray(v) && v.every((n) => typeof n === "string" && NAME.test(n));
  if (!e || typeof e.files?.["connection.ts"] !== "string" || !names(e.env) || !names(e.optionalEnv) || typeof e.version !== "string")
    throw new Error(`${from}: not a catalog entry (files["connection.ts"], env, optionalEnv, version)`);
  return e;
}

/** The connection folders' parent: the config's `dir`, else `src/oc` (created). */
async function foldersDir(o: AddOptions): Promise<string> {
  const config = findConfig(o.dir, o.config);
  const c = await importConfig(config, join(workdir(o.dir), "build"), `add-${Date.now()}`);
  return dirOf(c, { ...o.env }, config) ?? join(o.dir, "src/oc");
}

const shown = (o: AddOptions, p: string) => relative(o.dir, p) || p;

/** `connectd add`: the catalog. */
export async function list(o: AddOptions): Promise<void> {
  const log = o.log ?? console.log;
  const all = await read<Listed[]>(o, "index.json");
  const w = Math.max(...all.map((e) => e.id.length));
  log(["Providers (connectd add <provider>):", ...all.map((e) => `  ${e.id.padEnd(w)}  ${e.description}`)].join("\n"));
}

/** `connectd add <provider> [--id <folder>] [--force]`: copy it in, an empty events.ts beside it, its env names into .env. */
export async function add(o: AddOptions & { provider: string; id?: string; force?: boolean }): Promise<void> {
  const log = o.log ?? console.log;
  if (!ID.test(o.provider)) throw new Error(`no provider ${o.provider}: \`connectd add\` lists them`);
  const id = o.id ?? o.provider;
  if (!ID.test(id)) throw new Error("--id: letters, digits, _ and - only (it's the connection's id)");
  const e = checked(await read<Entry>(o, `${o.provider}.json`), `${o.provider}.json`);
  const wrote = await write(o, id, `${header(e, id)}\n${e.files["connection.ts"]}`, e.env, e.optionalEnv, `connectd add ${o.provider}`, !!o.force);
  log(
    [
      `added ${o.provider}@${e.version} as ${id}: ${wrote.join(", ")}`,
      `  from ${registryOf(o)}: it's code your app runs; read it before you deploy`,
      e.env.length ? `  set ${e.env.join(", ")} in .env` : "",
      "  connection.ts imports @kavishkagaya/connectd/connections, events.ts @kavishkagaya/connectd/sdk (npm i @kavishkagaya/connectd if it's missing)",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

/** `connectd add --custom <id> [--template <flow>]`: a provider the catalog doesn't have, from a template; written like a copied one. */
export async function custom(o: AddOptions & { id: string; template?: string; force?: boolean }): Promise<void> {
  const log = o.log ?? console.log;
  if (!ID.test(o.id)) throw new Error("--custom: letters, digits, _ and - only (it's the connection's id)");
  const t = (o.template ?? "oauth2") as Template;
  if (!TEMPLATES.includes(t)) throw new Error(`no template ${o.template}: ${TEMPLATES.join(", ")}`);
  const { source, env } = template(t, o.id);
  const wrote = await write(o, o.id, `// connectd: custom (${t} template). Written by \`connectd add --custom\`; yours to edit.\n${source}`, env, [], `connectd add --custom ${o.id}`, !!o.force);
  log(
    [
      `added ${o.id} from the ${t} template: ${wrote.join(", ")}`,
      "  fill in the example.com URLs (the provider's endpoints and API), scopes and identity",
      env.length ? `  set ${env.join(", ")} in .env` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

/** A connection folder: its connection.ts, an empty events.ts beside it, its env names into .env. What was written, as shown. */
async function write(o: AddOptions, id: string, source: string, required: string[], optional: string[], by: string, force: boolean): Promise<string[]> {
  const folder = join(await foldersDir(o), id);
  const file = join(folder, "connection.ts");
  if (existsSync(file) && !force)
    throw new Error(`${shown(o, file)} exists: ${HEADER.test(readFileSync(file, "utf8")) ? `\`connectd diff ${id}\` shows what changed upstream, ` : ""}--force overwrites it`);
  mkdirSync(folder, { recursive: true });
  writeFileSync(file, source);
  const wrote = [shown(o, file)];
  const events = join(folder, "events.ts");
  if (!existsSync(events)) {
    writeFileSync(
      events,
      `import { listen } from "@kavishkagaya/connectd/sdk";\n\n// Your app's handlers for ${id}'s events (runs in your app, through oc.routes).\nexport default listen(${JSON.stringify(id)});\n`,
    );
    wrote.push(shown(o, events));
  }
  // The env names it reads, empty, once: values are yours to fill in.
  const envFile = join(o.dir, ".env");
  const before = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
  const have = parseEnv(before);
  // Required: unless set. Optional: unless set or listed commented out (it stays so until it's wanted).
  const listed = (n: string) => before.split(/\r?\n/).some((l) => l.replace(/^\s*#\s*/, "").replace(/\s+=/, "=").startsWith(`${n}=`));
  const names = [...required.filter((n) => !Object.hasOwn(have, n)), ...optional.filter((n) => !Object.hasOwn(have, n) && !listed(n))];
  if (names.length) {
    const lines = [`# ${id} (${by})`, ...required.filter((n) => names.includes(n)).map((n) => `${n}=`), ...optional.filter((n) => names.includes(n)).flatMap((n) => ["# optional:", `# ${n}=`])];
    appendFileSync(envFile, `${before && !before.endsWith("\n") ? "\n" : ""}${before ? "\n" : ""}${lines.join("\n")}\n`);
    wrote.push(".env");
  }
  return wrote;
}

const header = (e: Entry, id: string) =>
  `// connectd: ${e.id}@${e.version}. Copied by \`connectd add\`; yours to edit. \`connectd diff ${id}\` shows what changed upstream.`;

/** `connectd diff <id>`: the folder's connection.ts against the catalog's current one. Resolves to whether they differ. */
export async function diff(o: AddOptions & { id: string }): Promise<boolean> {
  const log = o.log ?? console.log;
  if (!ID.test(o.id)) throw new Error(`no connection folder ${o.id}`);
  const file = join(await foldersDir(o), o.id, "connection.ts");
  if (!existsSync(file)) throw new Error(`no ${shown(o, file)}`);
  // CRLF (a Windows checkout) would differ on every line.
  const [first = "", ...body] = readFileSync(file, "utf8").replace(/\r\n/g, "\n").split("\n");
  const m = HEADER.exec(first);
  if (first.startsWith("// connectd: custom")) throw new Error(`${shown(o, file)} is a custom connection (\`connectd add --custom\`): there's no upstream to diff`);
  if (!m) throw new Error(`${shown(o, file)} wasn't copied by \`connectd add\` (no "// connectd: <provider>@<version>" first line)`);
  const e = checked(await read<Entry>(o, `${m[1]}.json`), `${m[1]}.json`);
  const ours = body.join("\n");
  const theirs = e.files["connection.ts"] ?? "";
  if (ours === theirs) {
    log(`${o.id} matches ${m[1]}@${e.version}${m[2] === e.version ? "" : ` (copied at ${m[2]})`}`);
    return false;
  }
  log([`--- ${shown(o, file)} (yours, from ${m[1]}@${m[2]})`, `+++ ${m[1]}@${e.version} (the catalog's)`, ...unified(ours.split("\n"), theirs.split("\n"))].join("\n"));
  return true;
}

/** A unified diff of two line lists, 3 lines of context. LCS: provider files are hundreds of lines, not thousands. */
export function unified(a: string[], b: string[], context = 3): string[] {
  // ponytail: O(n·m) table; Myers if anyone diffs a file of 10k lines.
  const n = a.length;
  const m = b.length;
  const t = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i]![j] = a[i] === b[j] ? t[i + 1]![j + 1]! + 1 : Math.max(t[i + 1]![j]!, t[i]![j + 1]!);
  const ops: { k: " " | "-" | "+"; line: string; i: number; j: number }[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) ops.push({ k: " ", line: a[i]!, i: i++, j: j++ });
    // Deletions first, as diff prints them.
    else if (i < n && (j === m || t[i + 1]![j]! >= t[i]![j + 1]!)) ops.push({ k: "-", line: a[i]!, i: i++, j });
    else ops.push({ k: "+", line: b[j]!, i, j: j++ });
  }
  const out: string[] = [];
  for (let x = 0; x < ops.length; ) {
    if (ops[x]!.k === " ") {
      x++;
      continue;
    }
    // A hunk: from `context` lines before this change to `context` lines after the last change within reach.
    const start = Math.max(0, x - context);
    let end = x;
    while (end < ops.length) {
      if (ops[end]!.k !== " ") {
        end++;
        continue;
      }
      let run = 0;
      while (end + run < ops.length && ops[end + run]!.k === " ") run++;
      if (end + run >= ops.length || run > 2 * context) {
        end = Math.min(ops.length, end + context);
        break;
      }
      end += run;
    }
    const h = ops.slice(start, end);
    const aLen = h.filter((o) => o.k !== "+").length;
    const bLen = h.filter((o) => o.k !== "-").length;
    out.push(`@@ -${h[0]!.i + 1},${aLen} +${h[0]!.j + 1},${bLen} @@`, ...h.map((o) => `${o.k}${o.line}`));
    x = end;
  }
  return out;
}
