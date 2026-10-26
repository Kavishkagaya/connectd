/**
 * `bun run pack`: the published packages as npm tarballs that run on Node (and Bun), in `.pack/`.
 * The workspace runs the TypeScript sources; a published package carries JavaScript (`dist/`, with
 * declarations), so `npx connectd` works without Bun. tsc emits it in the three type environments the
 * typecheck uses (Bun/Node, Workers, DOM).
 *
 * Only the packages without `"private": true` are published: `@kavishkagaya/connectd` (the one an app
 * installs) and `@kavishkagaya/connectd-cloudflare` (the deploy target). A published package carries
 * its private workspace dependencies inside it (`<pkg>/dist`, plus their `files`, like the runtime's
 * migrations), with the imports of them rewritten to relative paths. Its re-export files
 * (`export * from "@kavishkagaya/connectd-sdk"`, so the workspace resolves `@kavishkagaya/connectd/sdk`)
 * aren't shipped: those exports point at the carried package directly.
 *
 *   bun run pack && npm i ./.pack/kavishkagaya-connectd-0.2.0.tgz
 */
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const PACK = join(ROOT, ".pack");
const OUT = join(PACK, "out");

/** Not shipped: tests, test harnesses that import bun:test, dev scripts. */
const SKIP = [/\.test\.ts$/, /\/testkit\.ts$/, /\/fake\.ts$/, /kernel\/src\/drivers\/parity\.ts$/, /providers\/src\/registry\.ts$/];
/** Compiled with Workers types (they import cloudflare:workers). */
const WORKERS = ["kernel/src/drivers/do.ts", "runtime/src/cloudflare.ts"];
/** Browser packages: DOM types. */
const DOM = ["connect", "dashboard"];
/** Shipped as source: the Worker entry template `connectd deploy` fills in, and its config type. */
const TEMPLATES: Record<string, string[]> = { cloudflare: ["worker.ts", "config.d.ts"] };
/** Exports that are for this repo's own tests. */
const PRIVATE_EXPORTS: Record<string, string[]> = { kernel: ["./parity"] };
/** A file that is only `export * from "<package>"` (after comments): a re-export of another package. */
const REEXPORT = /^(?:\s*\/\/[^\n]*\n)*\s*export \* from "(@[^"]+)";\s*$/;

type Manifest = {
  name: string;
  version: string;
  private?: boolean;
  exports: Record<string, string>;
  bin?: Record<string, string>;
  files?: string[];
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  [k: string]: unknown;
};

const packages = readdirSync(join(ROOT, "packages")).filter((p) => existsSync(join(ROOT, "packages", p, "package.json")));
const manifest = (p: string) => JSON.parse(readFileSync(join(ROOT, "packages", p, "package.json"), "utf8")) as Manifest;
const byName = Object.fromEntries(packages.map((p) => [manifest(p).name, p]));
const reexport = (p: string, file: string) => REEXPORT.exec(readFileSync(join(ROOT, "packages", p, file), "utf8"))?.[1];

function sources(p: string): string[] {
  const walk = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".ts") && !e.name.endsWith(".d.ts") ? [join(d, e.name)] : []));
  return walk(join(ROOT, "packages", p, "src"))
    .map((f) => relative(join(ROOT, "packages"), f).split("\\").join("/"))
    .filter((f) => !SKIP.some((r) => r.test(f)) && !(TEMPLATES[p] ?? []).some((t) => f === `${p}/src/${t}`) && !reexport(p, f.slice(p.length + 1)));
}

function tsc(name: string, files: string[], options: Record<string, unknown>) {
  const config = join(PACK, `tsconfig.${name}.json`);
  writeFileSync(
    config,
    JSON.stringify({
      extends: "../tsconfig.json",
      compilerOptions: {
        noEmit: false,
        declaration: true,
        allowImportingTsExtensions: false,
        rewriteRelativeImportExtensions: true,
        rootDir: "../packages",
        outDir: "out",
        ...options,
      },
      files: files.map((f) => `../packages/${f}`),
      include: [],
      exclude: [],
    }),
  );
  const r = spawnSync(join(ROOT, "node_modules", ".bin", "tsc"), ["-p", config], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`tsc (${name}) failed`);
}

const pkgs = (sel: (p: string) => boolean) => packages.filter(sel).flatMap(sources);
// Installed with the packages that test in workerd, not at the root.
const WORKERS_TYPES = { types: ["@cloudflare/workers-types"], typeRoots: ["../packages/kernel/node_modules"] };

rmSync(PACK, { recursive: true, force: true });
mkdirSync(PACK);
tsc("node", pkgs((p) => !DOM.includes(p)).filter((f) => !WORKERS.includes(f)), {});
tsc("workers", WORKERS, WORKERS_TYPES);
tsc("dom", pkgs((p) => DOM.includes(p)), { lib: ["ES2022", "DOM", "DOM.Iterable"] });

const workspace = (v: string) => v.startsWith("workspace:");
/** The private workspace packages `p` depends on, transitively: carried inside it. */
function carried(p: string, seen = new Set<string>()): Set<string> {
  const m = manifest(p);
  for (const [name, v] of Object.entries({ ...m.dependencies, ...m.peerDependencies })) {
    const q = byName[name];
    if (!workspace(v) || !q || !manifest(q).private || seen.has(q)) continue;
    seen.add(q);
    carried(q, seen);
  }
  return seen;
}

/** Where a specifier of a carried package lands in the stage: `<q>/dist/...`. Null for anything else. */
function target(spec: string, inside: Set<string>): string | null {
  const name = spec.split("/").slice(0, 2).join("/");
  const q = byName[name];
  if (!q || !inside.has(q)) return null;
  const sub = `.${spec.slice(name.length)}`;
  const file = manifest(q).exports[sub];
  if (!file) throw new Error(`${spec}: ${name} has no export "${sub}"`);
  return join(q, file.replace(/^\.\/src\//, "dist/").replace(/\.ts$/, ".js"));
}

const files = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? files(join(d, f)) : [join(d, f)]));
const IMPORT = /((?:from|import)\s*\(?\s*)"(@kavishkagaya\/connectd-[a-z]+(?:\/[\w./-]+)?)"/g;

const tarballs: string[] = [];
for (const p of packages) {
  const json = manifest(p);
  if (json.private) continue;
  const src = join(ROOT, "packages", p);
  const stage = join(PACK, "pkg", p);
  const inside = carried(p);
  mkdirSync(stage, { recursive: true });

  // Its own code, then each carried package's, at <q>/dist with the files it ships (migrations).
  cpSync(join(OUT, p, "src"), join(stage, "dist"), { recursive: true });
  for (const t of TEMPLATES[p] ?? []) copyFileSync(join(src, "src", t), join(stage, "dist", t));
  const extra = (json.files ?? []).filter((f) => f !== "src" && f !== "dist");
  for (const f of extra) cpSync(join(src, f), join(stage, f), { recursive: true });
  for (const q of inside) {
    cpSync(join(OUT, q, "src"), join(stage, q, "dist"), { recursive: true });
    for (const f of (manifest(q).files ?? []).filter((f) => f !== "src" && f !== "dist")) cpSync(join(ROOT, "packages", q, f), join(stage, q, f), { recursive: true });
  }
  for (const f of ["README.md", "LICENSE"]) {
    const from = existsSync(join(src, f)) ? join(src, f) : join(ROOT, f);
    if (existsSync(from)) copyFileSync(from, join(stage, f));
  }

  // Imports of carried packages become relative; any other private package is an error.
  for (const f of files(stage).filter((f) => /\.(js|d\.ts)$/.test(f))) {
    const code = readFileSync(f, "utf8").replace(IMPORT, (all, head: string, spec: string) => {
      const to = target(spec, inside);
      if (to) {
        const r = relative(dirname(f), join(stage, to)).split("\\").join("/");
        return `${head}"${r.startsWith(".") ? r : `./${r}`}"`;
      }
      if (byName[spec.split("/").slice(0, 2).join("/")] && manifest(byName[spec.split("/").slice(0, 2).join("/")] as string).private)
        throw new Error(`${relative(stage, f)} imports ${spec}, which isn't published and isn't carried by ${json.name}`);
      return all;
    });
    writeFileSync(f, code);
  }

  const entry = (v: string) => {
    const spec = reexport(p, v);
    const to = spec ? target(spec, inside) : null;
    const js = to ? `./${to}` : v.replace(/^\.\/src\//, "./dist/").replace(/\.ts$/, ".js");
    return { types: js.replace(/\.js$/, ".d.ts"), default: js };
  };
  const exports = Object.fromEntries(
    Object.entries(json.exports)
      .filter(([k]) => !(PRIVATE_EXPORTS[p] ?? []).includes(k))
      .map(([k, v]) => [k, entry(v)]),
  );
  const bin = json.bin && Object.fromEntries(Object.entries(json.bin).map(([k, v]) => [k, entry(v).default]));
  for (const b of Object.values(bin ?? {})) {
    // The workspace's bin runs on Bun; the published one on Node (Bun runs it too).
    const file = join(stage, b);
    writeFileSync(file, readFileSync(file, "utf8").replace(/^#!.*\n/, "#!/usr/bin/env node\n"));
    chmodSync(file, 0o755);
  }

  // Dependencies: the carried packages' outside ones join its own; published workspace ones are pinned.
  const deps = (field: "dependencies" | "peerDependencies") => {
    const all: Record<string, string> = {};
    for (const m of [json, ...[...inside].map(manifest)])
      for (const [k, v] of Object.entries(m[field] ?? {})) {
        const q = byName[k];
        if (q && (inside.has(q) || q === p)) continue;
        all[k] = workspace(v) ? `^${q ? manifest(q).version : v}` : v;
      }
    return Object.keys(all).length ? { [field]: all } : {};
  };
  const { scripts: _s, devDependencies: _d, dependencies: _deps, peerDependencies: _peers, ...rest } = json;
  const out = {
    ...rest,
    exports,
    ...(bin ? { bin } : {}),
    files: ["dist", ...extra, ...inside],
    ...deps("dependencies"),
    ...deps("peerDependencies"),
    engines: { node: ">=20" },
  };
  writeFileSync(join(stage, "package.json"), `${JSON.stringify(out, null, 2)}\n`);
  const r = spawnSync("npm", ["pack", "--silent", "--pack-destination", PACK], { cwd: stage, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`npm pack ${p}: ${r.stderr}`);
  tarballs.push(join(PACK, r.stdout.trim().split("\n").at(-1) ?? ""));
}
console.log(tarballs.map((t) => relative(ROOT, t)).join("\n"));
