/**
 * `bun run pack`: the packages as npm tarballs that run on Node (and Bun), in `.pack/`. The
 * workspace runs the TypeScript sources; a published package carries JavaScript (`dist/`, with
 * declarations), so `npx connectd` works without Bun. tsc emits it in the three type
 * environments the typecheck uses (Bun/Node, Workers, DOM); each package is staged with its
 * package.json pointed at `dist/` and its `workspace:*` versions pinned, then `npm pack`ed.
 *
 *   bun run pack && npm i -D ./.pack/connectd-cli-0.0.0.tgz ...
 *
 * ponytail: tarballs only; `npm publish` of each, in dependency order, once there's a release.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

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

const packages = readdirSync(join(ROOT, "packages")).filter((p) => existsSync(join(ROOT, "packages", p, "package.json")));

function sources(p: string): string[] {
  const walk = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".ts") && !e.name.endsWith(".d.ts") ? [join(d, e.name)] : []));
  return walk(join(ROOT, "packages", p, "src"))
    .map((f) => relative(join(ROOT, "packages"), f).split("\\").join("/"))
    .filter((f) => !SKIP.some((r) => r.test(f)) && !(TEMPLATES[p] ?? []).some((t) => f === `${p}/src/${t}`));
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

const version = (p: string) => (JSON.parse(readFileSync(join(ROOT, "packages", p, "package.json"), "utf8")) as { version: string }).version;
const versions = Object.fromEntries(packages.map((p) => [`@connectd/${p}`, version(p)]));
/** `./src/x.ts` → `./dist/x.js` (and its declarations). */
const dist = (f: string) => f.replace(/^\.\/src\//, "./dist/").replace(/\.ts$/, ".js");
const pin = (deps?: Record<string, string>) =>
  deps && Object.fromEntries(Object.entries(deps).map(([k, v]) => [k, v.startsWith("workspace:") ? `^${versions[k] ?? v}` : v]));

const tarballs: string[] = [];
for (const p of packages) {
  const src = join(ROOT, "packages", p);
  const json = JSON.parse(readFileSync(join(src, "package.json"), "utf8"));
  if (json.private) continue;
  const stage = join(PACK, "pkg", p);
  mkdirSync(stage, { recursive: true });
  cpSync(join(OUT, p, "src"), join(stage, "dist"), { recursive: true });
  for (const t of TEMPLATES[p] ?? []) copyFileSync(join(src, "src", t), join(stage, "dist", t));
  const extra = ((json.files as string[] | undefined) ?? []).filter((f) => f !== "src" && f !== "dist");
  for (const f of extra) cpSync(join(src, f), join(stage, f), { recursive: true });
  for (const f of ["README.md", "LICENSE"]) {
    const from = existsSync(join(src, f)) ? join(src, f) : join(ROOT, f);
    if (existsSync(from)) copyFileSync(from, join(stage, f));
  }
  const exports = Object.fromEntries(
    Object.entries(json.exports as Record<string, string>)
      .filter(([k]) => !(PRIVATE_EXPORTS[p] ?? []).includes(k))
      .map(([k, v]) => [k, { types: dist(v).replace(/\.js$/, ".d.ts"), default: dist(v) }]),
  );
  const bin = json.bin && Object.fromEntries(Object.entries(json.bin as Record<string, string>).map(([k, v]) => [k, dist(v)]));
  for (const b of Object.values((bin ?? {}) as Record<string, string>)) {
    // The workspace's bin runs on Bun; the published one on Node (Bun runs it too).
    const file = join(stage, b);
    writeFileSync(file, readFileSync(file, "utf8").replace(/^#!.*\n/, "#!/usr/bin/env node\n"));
    chmodSync(file, 0o755);
  }
  const { scripts: _s, devDependencies: _d, ...rest } = json;
  const out = {
    ...rest,
    exports,
    ...(bin ? { bin } : {}),
    files: ["dist", ...extra],
    ...(json.dependencies ? { dependencies: pin(json.dependencies) } : {}),
    ...(json.peerDependencies ? { peerDependencies: pin(json.peerDependencies) } : {}),
    engines: { node: ">=20" },
  };
  writeFileSync(join(stage, "package.json"), `${JSON.stringify(out, null, 2)}\n`);
  const r = spawnSync("npm", ["pack", "--silent", "--pack-destination", PACK], { cwd: stage, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`npm pack ${p}: ${r.stderr}`);
  tarballs.push(join(PACK, r.stdout.trim().split("\n").at(-1) ?? ""));
}
console.log(tarballs.map((t) => relative(ROOT, t)).join("\n"));
