import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./cli.ts";
import { parseEnv } from "./env.ts";
import { init, installCommand, packageManager } from "./init.ts";

const app = (files: Record<string, string> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "connectd-init-"));
  for (const [f, s] of Object.entries(files)) mkdirSync(join(dir, f, ".."), { recursive: true }), writeFileSync(join(dir, f), s);
  return dir;
};
const read = (dir: string, f: string) => readFileSync(join(dir, f), "utf8");
test("init in a Next.js app: .env (the root key, CONNECTD_URL, APP_URL), .gitignore, config, lib/oc.ts, the route", async () => {
  const dir = app({
    "package.json": JSON.stringify({ name: "@acme/web", dependencies: { next: "16.0.0", "@kavishkagaya/connectd-cloudflare": "0.0.0" } }),
    "src/app/page.tsx": "export default () => null;\n",
    ".env": "DATABASE_URL=postgres://app",
    ".gitignore": "node_modules\n",
  });
  const lines: string[] = [];
  await init({ skipInstall: true, dir, log: (l) => void lines.push(l) });
  const env = parseEnv(read(dir, ".env"));
  // The app's own line kept, connectd's appended.
  expect(read(dir, ".env").startsWith("DATABASE_URL=postgres://app\n\n")).toBe(true);
  // Only the root key: dev derives its own keys from it and writes the app's API key itself.
  expect(Object.keys(env).sort()).toEqual(["APP_URL", "CONNECTD_ROOT_KEY", "CONNECTD_URL", "DATABASE_URL"]);
  expect(env).toMatchObject({ APP_URL: "http://localhost:3000", CONNECTD_URL: "http://localhost:8787" });
  expect(env.CONNECTD_ROOT_KEY).toMatch(/^ocroot_[A-Za-z0-9+/]{43}=$/);
  expect(read(dir, ".gitignore")).toBe("node_modules\n.env\n");

  const config = read(dir, "oc.config.ts");
  expect(config).toContain('dir: "src/oc"');
  expect(config).toContain('target: cloudflare({ name: "web" })');
  expect(config).toContain("events: { url: `${env.APP_URL}/api/connectd/events` }");
  expect(config).toContain("sessions: { origins: [env.APP_URL as string] }");
  expect(existsSync(join(dir, "src/oc"))).toBe(true);
  expect(read(dir, "src/lib/oc.ts")).toContain('import { listeners } from "../../.connectd/app";');
  expect(read(dir, "src/app/api/connectd/[...path]/route.ts")).toContain('import { oc } from "../../../../lib/oc";\n\n// connect/:def, return, events (oc.routes).\nexport const { GET, POST } = oc.routes;');
  const out = lines.join("\n");
  expect(out).toContain("wrote .env, .gitignore, oc.config.ts, src/lib/oc.ts, src/app/api/connectd/[...path]/route.ts");
  expect(out).toContain("keep a copy in your password manager");
  expect(out).not.toContain("mount GET and POST");

  // Again: nothing new, nothing replaced (the root key never changes).
  const before = read(dir, ".env");
  const again: string[] = [];
  await init({ skipInstall: true, dir, log: (l) => void again.push(l) });
  expect(read(dir, ".env")).toBe(before);
  expect(again.join("\n")).toContain("nothing to write: already set up");
});

test("init elsewhere: a new .env (owner only), the config at the root, the route left to mount; --port, --app-url", async () => {
  const dir = app({ "package.json": JSON.stringify({ name: "api" }), "package-lock.json": "{}" });
  const lines: string[] = [];
  expect(await main(["init", "--skip-install", "--port", "9000", "--app-url", "http://localhost:4000/"], { dir, log: (l) => void lines.push(l) })).toBe(0);
  expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600);
  expect(parseEnv(read(dir, ".env"))).toMatchObject({ APP_URL: "http://localhost:4000", CONNECTD_URL: "http://localhost:9000" });
  expect(read(dir, ".gitignore")).toBe(".env\n");
  expect(read(dir, "oc.config.ts")).toContain('dir: "oc"');
  expect(read(dir, "oc.config.ts")).not.toContain("cloudflare");
  expect(read(dir, "lib/oc.ts")).toContain('from "../.connectd/app"');
  expect(existsSync(join(dir, "app"))).toBe(false);
  const out = lines.join("\n");
  expect(out).toContain("mount GET and POST at /api/connectd/*");
  expect(out).toContain("npm install -D @kavishkagaya/connectd-cloudflare wrangler, then target: cloudflare({ name })");
  expect(out).toContain("http://localhost:9000");
  expect(await main(["init", "--skip-install", "--app-url", "localhost:3000"], { dir: app(), log: () => {} })).toBe(1);
});

test("init keeps what's there: a root key (a teammate's), an existing config", async () => {
  const root = "ocroot_" + btoa("r".repeat(32));
  const dir = app({ ".env": `CONNECTD_ROOT_KEY=${root}\nAPP_URL=https://app.test\n`, "oc.config.ts": "export default {};\n", ".gitignore": ".env*\n" });
  const lines: string[] = [];
  await init({ skipInstall: true, dir, log: (l) => void lines.push(l) });
  const env = parseEnv(read(dir, ".env"));
  expect(env.CONNECTD_ROOT_KEY).toBe(root);
  expect(env.APP_URL).toBe("https://app.test");
  expect(read(dir, "oc.config.ts")).toBe("export default {};\n");
  expect(read(dir, ".gitignore")).toBe(".env*\n");
  const out = lines.join("\n");
  expect(out).toContain("kept oc.config.ts");
  expect(out).not.toContain("password manager");
});

test("init: .gitignore forms, an appended .env made owner only, empty values, Next's root app/ or pages/, bad origins", async () => {
  // `.env.*` doesn't ignore .env; `!.env` undoes `.env*`.
  for (const [gi, added] of [[".env.*\n", true], [".env*\n!.env\n", true], ["/.env\n", false], [".env*\n", false]] as const) {
    const dir = app({ ".gitignore": gi });
    await init({ skipInstall: true, dir, log: () => {} });
    expect([gi, read(dir, ".gitignore")]).toEqual([gi, added ? `${gi}.env\n` : gi]);
  }
  const shared = app({ ".env": "DATABASE_URL=x\nCONNECTD_ROOT_KEY=\n" });
  chmodSync(join(shared, ".env"), 0o644);
  await init({ skipInstall: true, dir: shared, log: () => {} });
  expect(statSync(join(shared, ".env")).mode & 0o777).toBe(0o600);
  // Empty is missing: filled (the later line wins), so dev doesn't send you back to init forever.
  expect(parseEnv(read(shared, ".env")).CONNECTD_ROOT_KEY).toStartWith("ocroot_");

  const next = JSON.stringify({ dependencies: { next: "16" } });
  for (const root of ["app/layout.tsx", "pages/index.tsx"]) {
    const dir = app({ "package.json": next, "src/lib/util.ts": "", [root]: "" });
    await init({ skipInstall: true, dir, log: () => {} });
    expect(read(dir, "app/api/connectd/[...path]/route.ts")).toContain('from "../../../../src/lib/oc"');
    expect(existsSync(join(dir, "src/app"))).toBe(false);
  }
  for (const bad of ["http://user@evil.test", "http://localhost:3000/app", "ftp://x.test"]) await expect(init({ skipInstall: true, dir: app(), appUrl: bad, log: () => {} })).rejects.toThrow("--app-url must be an origin");
  await expect(init({ skipInstall: true, dir: app({ ".env": "APP_URL=http://localhost:3000/x\n" }), log: () => {} })).rejects.toThrow("APP_URL in .env must be an origin");
});

test("init refuses to put the root key in a .env git tracks", async () => {
  const dir = app({ ".env": "DATABASE_URL=x\n" });
  const git = (...a: string[]) => spawnSync("git", a, { cwd: dir });
  git("init", "-q");
  git("add", ".env");
  await expect(init({ skipInstall: true, dir, log: () => {} })).rejects.toThrow("`.env` is tracked by git");
  expect(read(dir, ".env")).toBe("DATABASE_URL=x\n");
  git("rm", "-q", "--cached", ".env");
  await init({ skipInstall: true, dir, log: () => {} });
  expect(parseEnv(read(dir, ".env")).CONNECTD_ROOT_KEY).toStartWith("ocroot_");
  expect(git("check-ignore", "-q", ".env").status).toBe(0);
});

/** Scripted answers, in order; each question is recorded. */
function scripted(answers: { text?: string[]; confirm?: boolean[]; choose?: string[]; checklist?: string[][] }) {
  const asked: string[] = [];
  const next = <T>(xs: T[] | undefined, q: string): T => {
    asked.push(q.trim());
    if (!xs?.length) throw new Error(`unexpected question: ${q}`);
    return xs.shift() as T;
  };
  const prompts = {
    text: async (q: string, fallback: string) => next(answers.text, q) || fallback,
    confirm: async (q: string) => next(answers.confirm, q),
    choose: async (q: string) => next(answers.choose, q),
    checklist: async (q: string) => next(answers.checklist, q),
  };
  return { prompts, asked };
}

const VERSION = (JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as { version: string }).version;
const at = (p: string) => (VERSION === "0.0.0" ? p : `${p}@^${VERSION}`);

test("init --target: installs @kavishkagaya/connectd, then the target's packages with the project's package manager, and writes the target into the config", async () => {
  const dir = app({ "package.json": JSON.stringify({ name: "web" }), "pnpm-lock.yaml": "" });
  const ran: string[][] = [];
  const lines: string[] = [];
  await init({ dir, target: "cloudflare", run: (cmd, args) => (ran.push([cmd, ...args]), 0), log: (l) => void lines.push(l) });
  expect(ran).toEqual([
    ["pnpm", "add", at("@kavishkagaya/connectd")],
    ["pnpm", "add", "-D", at("@kavishkagaya/connectd-cloudflare"), "wrangler"],
  ]);
  const config = read(dir, "oc.config.ts");
  expect(config).toContain('import { cloudflare } from "@kavishkagaya/connectd-cloudflare";');
  expect(config).toContain('target: cloudflare({ name: "web" })');
  expect(lines.join("\n")).toContain("connectd deploy");
  // CONNECTD_TARBALLS: a local build's tarballs instead of npm's.
  const tarballs = app({ [`kavishkagaya-connectd-${VERSION}.tgz`]: "" });
  const local = app({ "package.json": JSON.stringify({ name: "l" }), "package-lock.json": "{}" });
  const ran2: string[][] = [];
  await init({ dir: local, env: { CONNECTD_TARBALLS: tarballs }, run: (cmd, args) => (ran2.push([cmd, ...args]), 0), log: () => {} });
  expect(ran2).toEqual([["npm", "install", join(tarballs, `kavishkagaya-connectd-${VERSION}.tgz`)]]);
});

test("init in a terminal: the setup asks step by step (origin, port, install, target, providers); flags and .env answer their own questions", async () => {
  const ran: string[][] = [];
  const run = (cmd: string, args: string[]) => (ran.push([cmd, ...args]), 0);
  const registry = app({
    "index.json": JSON.stringify([
      { id: "github-app", version: "0.0.0", description: "GitHub App" },
      { id: "github", version: "0.0.0", description: "GitHub OAuth" },
      { id: "acme", version: "0.0.0", description: "Acme" },
    ]),
    "github.json": JSON.stringify({ id: "github", version: "0.0.0", description: "", env: ["GITHUB_CLIENT_ID"], optionalEnv: [], files: { "connection.ts": "export default 1;\n" } }),
  });
  let listed: { value: string; alone?: boolean }[] = [];
  const s = scripted({ text: ["http://localhost:4000", "9000"], confirm: [true], choose: ["cloudflare"], checklist: [["github"]] });
  const checklist = s.prompts.checklist;
  s.prompts.checklist = async (q: string, choices?: { value: string; alone?: boolean }[]) => ((listed = choices ?? []), checklist(q));
  const dir = app({ "package.json": JSON.stringify({ name: "a" }), "package-lock.json": "{}" });
  const lines: string[] = [];
  await init({ dir, prompts: s.prompts as never, registry, run, log: (l) => void lines.push(l) });
  expect(s.asked.map((q) => q.replace(/ \(.*/, ""))).toEqual(["1. Your app's origin in dev", "2. Port for connectd dev", "3. Install @kavishkagaya/connectd", "4. Where will connectd run when you deploy?", "5. Providers to add"]);
  const env = parseEnv(read(dir, ".env"));
  expect(env.APP_URL).toBe("http://localhost:4000");
  expect(env.CONNECTD_URL).toBe("http://localhost:9000");
  expect(ran.map((r) => r.slice(0, 3))).toEqual([["npm", "install", at("@kavishkagaya/connectd")], ["npm", "install", "-D"]]);
  expect(read(dir, "oc.config.ts")).toContain("target: cloudflare(");
  // Popular first, the rest after, and "Add later" alone.
  expect(listed.map((c) => c.value)).toEqual(["github", "github-app", "acme", ""]);
  expect(listed.at(-1)?.alone).toBe(true);
  expect(existsSync(join(dir, "oc", "github", "connection.ts")), lines.join("\n")).toBe(true);
  expect(env.GITHUB_CLIENT_ID).toBeDefined();
  expect(lines.join("\n")).toContain("fill in the client id and secret for github");
  expect(lines.join("\n")).toContain("added github@0.0.0 as github: oc/github/connection.ts");

  // Answered already (flags, .env, installed, a config): nothing asked but the providers; "Add later" adds none.
  const later = scripted({ checklist: [[]] });
  const again = app({ "package.json": JSON.stringify({ name: "b", dependencies: { "@kavishkagaya/connectd": "^0.2.0" } }), ".env": "APP_URL=http://localhost:3000\n" });
  await init({ dir: again, port: 8800, target: "none", prompts: later.prompts as never, registry, run, log: () => {} });
  expect(later.asked.map((q) => q.replace(/ \(.*/, ""))).toEqual(["1. Providers to add"]);
  expect(read(again, "oc.config.ts")).not.toContain("target:");

  // No to the install, "decide later" for the target: nothing installed.
  const none = scripted({ text: ["", ""], confirm: [false], choose: ["none"], checklist: [[]] });
  const n0 = ran.length;
  await init({ dir: app({ "package.json": JSON.stringify({ name: "c" }) }), prompts: none.prompts as never, registry, run, log: () => {} });
  expect(ran.length).toBe(n0);

  // --yes (and CI): no questions at all.
  const quiet = scripted({});
  await init({ dir: app({ "package.json": JSON.stringify({ name: "d" }) }), yes: true, prompts: quiet.prompts as never, registry, run, log: () => {} });
  expect(quiet.asked).toEqual([]);
  // --add: those providers, no checklist.
  const named = app({ "package.json": JSON.stringify({ name: "e" }) });
  await init({ dir: named, yes: true, providers: ["github"], registry, run, log: () => {} });
  expect(existsSync(join(named, "oc", "github", "connection.ts"))).toBe(true);
});

test("init --target with --skip-install, and a failed install: the config is written, the command printed", async () => {
  let ran = 0;
  const skip = app({ "package.json": JSON.stringify({ name: "a" }) });
  await init({ dir: skip, target: "cloudflare", skipInstall: true, run: () => (ran++, 0), log: () => {} });
  expect(ran).toBe(0);
  expect(read(skip, "oc.config.ts")).toContain("target: cloudflare(");

  const fail = app({ "package.json": JSON.stringify({ name: "b" }), "bun.lock": "" });
  const lines: string[] = [];
  await init({ dir: fail, target: "cloudflare", run: () => 1, log: (l) => void lines.push(l) });
  expect(lines.join("\n")).toMatch(/the install failed: run bun add -d @kavishkagaya\/connectd-cloudflare\S* wrangler yourself/);
  expect(await main(["init", "--target", "aws"], { dir: app(), log: () => {} })).toBe(2);
});

test("package manager: the lockfile's, else the one running connectd, else npm", () => {
  expect(packageManager(app({ "yarn.lock": "" }), "npm/10.9.8 node/v22.23.0 linux x64")).toBe("yarn");
  expect(packageManager(app(), "pnpm/10.25.0 npm/? node/v22.23.0 linux x64")).toBe("pnpm");
  expect(packageManager(app(), "")).toBe("npm");
  expect(installCommand("bun", ["x"])).toEqual(["bun", ["add", "-d", "x"]]);
  expect(installCommand("yarn", ["x"])).toEqual(["yarn", ["add", "-D", "x"]]);
});
