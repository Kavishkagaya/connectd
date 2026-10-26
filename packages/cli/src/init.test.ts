import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./cli.ts";
import { parseEnv } from "./env.ts";
import { init } from "./init.ts";

const app = (files: Record<string, string> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "connectd-init-"));
  for (const [f, s] of Object.entries(files)) mkdirSync(join(dir, f, ".."), { recursive: true }), writeFileSync(join(dir, f), s);
  return dir;
};
const read = (dir: string, f: string) => readFileSync(join(dir, f), "utf8");
const KEYS = ["CONNECTD_API_KEY", "CONNECTD_EVENTS_SECRET", "CONNECTD_KEY_V1", "CONNECTD_SESSIONS_KEY", "CONNECTD_STATE_KEY", "CONNECTD_WEBHOOKS_KEY"];

test("init in a Next.js app: .env (keys, CONNECTD_URL, APP_URL), .gitignore, config, lib/oc.ts, the route", async () => {
  const dir = app({
    "package.json": JSON.stringify({ name: "@acme/web", dependencies: { next: "16.0.0", "@kavishkagaya/connectd-cloudflare": "0.0.0" } }),
    "src/app/page.tsx": "export default () => null;\n",
    ".env": "DATABASE_URL=postgres://app",
    ".gitignore": "node_modules\n",
  });
  const lines: string[] = [];
  await init({ dir, log: (l) => void lines.push(l) });
  const env = parseEnv(read(dir, ".env"));
  // The app's own line kept, connectd's appended.
  expect(read(dir, ".env").startsWith("DATABASE_URL=postgres://app\n\n")).toBe(true);
  expect(Object.keys(env).sort()).toEqual(["APP_URL", "CONNECTD_URL", "DATABASE_URL", ...KEYS].sort());
  expect(env).toMatchObject({ APP_URL: "http://localhost:3000", CONNECTD_URL: "http://localhost:8787" });
  expect(env.CONNECTD_EVENTS_SECRET).toStartWith("whsec_");
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
  expect(out).not.toContain("mount GET and POST");

  // Again: nothing new, nothing replaced (the keys stay, so sealed credentials stay readable).
  const before = read(dir, ".env");
  const again: string[] = [];
  await init({ dir, log: (l) => void again.push(l) });
  expect(read(dir, ".env")).toBe(before);
  expect(again.join("\n")).toContain("nothing to write: already set up");
});

test("init elsewhere: a new .env (owner only), the config at the root, the route left to mount; --port, --app-url", async () => {
  const dir = app({ "package.json": JSON.stringify({ name: "api" }) });
  const lines: string[] = [];
  expect(await main(["init", "--port", "9000", "--app-url", "http://localhost:4000/"], { dir, log: (l) => void lines.push(l) })).toBe(0);
  expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600);
  expect(parseEnv(read(dir, ".env"))).toMatchObject({ APP_URL: "http://localhost:4000", CONNECTD_URL: "http://localhost:9000" });
  expect(read(dir, ".gitignore")).toBe(".env\n");
  expect(read(dir, "oc.config.ts")).toContain('dir: "oc"');
  expect(read(dir, "oc.config.ts")).not.toContain("cloudflare");
  expect(read(dir, "lib/oc.ts")).toContain('from "../.connectd/app"');
  expect(existsSync(join(dir, "app"))).toBe(false);
  const out = lines.join("\n");
  expect(out).toContain("mount GET and POST at /api/connectd/*");
  expect(out).toContain("npm i -D @kavishkagaya/connectd-cloudflare");
  expect(out).toContain("http://localhost:9000");
  expect(await main(["init", "--app-url", "localhost:3000"], { dir: app(), log: () => {} })).toBe(1);
});

test("init keeps what's there: set keys, an existing config, .connectd/dev.vars's keys moved", async () => {
  const dir = app({
    ".env": "CONNECTD_API_KEY=mine\nCONNECTD_KEY_V2=k2\nAPP_URL=https://app.test\n",
    ".connectd/dev.vars": "CONNECTD_STATE_KEY=old-state\nCONNECTD_KEY_V1=old-k1\n",
    "oc.config.ts": "export default {};\n",
    ".gitignore": ".env*\n",
  });
  const lines: string[] = [];
  await init({ dir, log: (l) => void lines.push(l) });
  const env = parseEnv(read(dir, ".env"));
  expect(env.CONNECTD_API_KEY).toBe("mine");
  // dev.vars's V1 comes over next to .env's V2: the old dev ran with both, so credentials sealed before V2 need it.
  expect(env.CONNECTD_KEY_V2).toBe("k2");
  expect(env.CONNECTD_KEY_V1).toBe("old-k1");
  expect(env.CONNECTD_STATE_KEY).toBe("old-state");
  expect(env.APP_URL).toBe("https://app.test");
  expect(read(dir, "oc.config.ts")).toBe("export default {};\n");
  expect(read(dir, ".gitignore")).toBe(".env*\n");
  const out = lines.join("\n");
  expect(out).toContain("kept oc.config.ts");
  expect(out).toContain("the keys from .connectd/dev.vars are in .env now");

  // Without keys in .env, dev.vars's encryption key comes over (sealed credentials stay readable).
  const old = app({ ".connectd/dev.vars": "CONNECTD_KEY_V1=old-k1\n" });
  await init({ dir: old, log: () => {} });
  expect(parseEnv(read(old, ".env")).CONNECTD_KEY_V1).toBe("old-k1");
});

test("init: .gitignore forms, an appended .env made owner only, empty values, Next's root app/ or pages/, bad origins", async () => {
  // `.env.*` doesn't ignore .env; `!.env` undoes `.env*`.
  for (const [gi, added] of [[".env.*\n", true], [".env*\n!.env\n", true], ["/.env\n", false], [".env*\n", false]] as const) {
    const dir = app({ ".gitignore": gi });
    await init({ dir, log: () => {} });
    expect([gi, read(dir, ".gitignore")]).toEqual([gi, added ? `${gi}.env\n` : gi]);
  }
  const shared = app({ ".env": "DATABASE_URL=x\nCONNECTD_KEY_V1=\nCONNECTD_API_KEY=\n" });
  chmodSync(join(shared, ".env"), 0o644);
  await init({ dir: shared, log: () => {} });
  expect(statSync(join(shared, ".env")).mode & 0o777).toBe(0o600);
  // Empty is missing: filled (the later line wins), so dev doesn't send you back to init forever.
  const env = parseEnv(read(shared, ".env"));
  expect(env.CONNECTD_KEY_V1).toBeTruthy();
  expect(env.CONNECTD_API_KEY).toStartWith("oc_");

  const next = JSON.stringify({ dependencies: { next: "16" } });
  for (const root of ["app/layout.tsx", "pages/index.tsx"]) {
    const dir = app({ "package.json": next, "src/lib/util.ts": "", [root]: "" });
    await init({ dir, log: () => {} });
    expect(read(dir, "app/api/connectd/[...path]/route.ts")).toContain('from "../../../../src/lib/oc"');
    expect(existsSync(join(dir, "src/app"))).toBe(false);
  }
  for (const bad of ["http://user@evil.test", "http://localhost:3000/app", "ftp://x.test"]) await expect(init({ dir: app(), appUrl: bad, log: () => {} })).rejects.toThrow("--app-url must be an origin");
  await expect(init({ dir: app({ ".env": "APP_URL=http://localhost:3000/x\n" }), log: () => {} })).rejects.toThrow("APP_URL in .env must be an origin");
});

test("init refuses to put keys in a .env git tracks", async () => {
  const dir = app({ ".env": "DATABASE_URL=x\n" });
  const git = (...a: string[]) => spawnSync("git", a, { cwd: dir });
  git("init", "-q");
  git("add", ".env");
  await expect(init({ dir, log: () => {} })).rejects.toThrow("`.env` is tracked by git");
  expect(read(dir, ".env")).toBe("DATABASE_URL=x\n");
  git("rm", "-q", "--cached", ".env");
  await init({ dir, log: () => {} });
  expect(parseEnv(read(dir, ".env")).CONNECTD_API_KEY).toStartWith("oc_");
  expect(git("check-ignore", "-q", ".env").status).toBe(0);
});
