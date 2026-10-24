import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parseEnv } from "./env.ts";
import { generateKeys } from "./keys.ts";
import { CONFIG_FILES, loadProject } from "./load.ts";
import { workdir } from "./workdir.ts";

/** dev's default port (dev.ts imports the runtime; this file stays light). */
const PORT = 8787;

/**
 * `connectd init` (#54): sets up dev, the one explicit step that makes its keys. In the app's
 * directory it writes, never overwriting what's there:
 *
 *   .env               the runtime's generated keys, CONNECTD_URL (where dev runs) and APP_URL (the
 *                      app's origin): the one file the app and connectd share
 *   .gitignore         `.env`, since it holds the keys now
 *   oc.config.ts       sessions.origins and events.url from env.APP_URL; connections in <src>/oc/
 *   <src>/lib/oc.ts    the client: connectd({ user, listeners })
 *   app/api/connectd/[...path]/route.ts   oc.routes, for a Next.js app (App Router)
 *
 * Keys a `connectd dev` from before kept in .connectd/dev.vars are moved over, so sealed
 * credentials stay readable. `dev` only reads .env; each deployed environment gets its own keys from
 * `deploy`.
 */

export type InitOptions = { dir: string; port?: number; appUrl?: string; log?: (line: string) => void };

const VERSIONED = /^CONNECTD_KEY_V\d+$/;

/**
 * The generated keys this project lacks (a name set to "" counts as missing). First every one an
 * older dev kept in .connectd/dev.vars (it ran with dev.vars under .env, so that's the set it sealed
 * with, every key version included), then fresh ones; no V1 when any key version is set.
 */
function keysFor(dir: string, have: Record<string, string>): { keys: Record<string, string>; moved: number } {
  const legacy = join(workdir(dir), "dev.vars");
  const old = existsSync(legacy) ? parseEnv(readFileSync(legacy, "utf8")) : {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(old)) if (v && !have[k] && k.startsWith("CONNECTD_")) out[k] = v;
  const moved = Object.keys(out).length;
  const set = (k: string) => !!(have[k] || out[k]);
  const versions = [...Object.keys(have), ...Object.keys(out)].some((k) => VERSIONED.test(k) && set(k));
  for (const [k, v] of Object.entries(generateKeys())) if (!set(k) && !(VERSIONED.test(k) && versions)) out[k] = v;
  return { keys: out, moved };
}

/** Whether git ignores `file` (parent .gitignores and negations included); outside a repo, the directory's own .gitignore. */
function ignored(dir: string, file: string): boolean {
  const r = spawnSync("git", ["check-ignore", "-q", file], { cwd: dir });
  // 0: ignored, 1: not; 128 (not a repo) or no git: read the file.
  if (r.status === 0 || r.status === 1) return r.status === 0;
  const gi = join(dir, ".gitignore");
  const lines = existsSync(gi) ? readFileSync(gi, "utf8").split(/\r?\n/).map((l) => l.trim()) : [];
  // ponytail: only the forms that ignore .env itself, a later `!.env` winning; git check-ignore covers the rest in a repo.
  let on = false;
  for (const l of lines)
    if (/^\/?\.env\*?$/.test(l)) on = true;
    else if (/^!\/?\.env$/.test(l)) on = false;
  return on;
}

const pkg = (dir: string) => {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  } catch {
    return null;
  }
};
const uses = (dir: string, name: string) => {
  const p = pkg(dir);
  return !!(p?.dependencies?.[name] ?? p?.devDependencies?.[name]);
};

/** `import x from "<from → to>"`, without the extension (as Next and TS resolve it). */
const spec = (from: string, to: string) => {
  const r = relative(dirname(from), to).split("\\").join("/").replace(/\.ts$/, "");
  return r.startsWith(".") ? r : `./${r}`;
};

export async function init(o: InitOptions): Promise<void> {
  const log = o.log ?? console.log;
  const dir = o.dir;
  const port = o.port ?? PORT;
  const wrote: string[] = [];
  const kept: string[] = [];
  const write = (file: string, text: string) => {
    const rel = relative(dir, file);
    if (existsSync(file)) return void kept.push(rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    wrote.push(rel);
  };

  // .env: what dev and the app read. Appended, never rewritten: the app's own lines stay as they are.
  const envFile = join(dir, ".env");
  const before = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
  const have = parseEnv(before);
  const from = o.appUrl !== undefined ? "--app-url" : have.APP_URL ? "APP_URL in .env" : "APP_URL";
  const appUrl = (o.appUrl ?? have.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  let origin: string | null = null;
  try {
    origin = new URL(appUrl).origin;
  } catch {}
  if (origin !== appUrl || !/^https?:/.test(appUrl)) throw new Error(`${from} must be an origin like http://localhost:3000 (${appUrl})`);
  const { keys, moved } = keysFor(dir, have);
  // Ignore rules don't apply to a tracked file: keys written there would go out with the next commit.
  if (Object.keys(keys).length && spawnSync("git", ["ls-files", "--error-unmatch", ".env"], { cwd: dir }).status === 0)
    throw new Error("`.env` is tracked by git, so the keys would be committed: `git rm --cached .env`, commit, then connectd init again");
  const lines = [
    ...(have.APP_URL ? [] : ["# Your app's origin: oc.config.ts builds sessions.origins and events.url from it.", `APP_URL=${appUrl}`]),
    ...(have.CONNECTD_URL ? [] : ["# Where `connectd dev` runs: the app's client calls it.", `CONNECTD_URL=http://localhost:${port}`]),
    ...(Object.keys(keys).length
      ? ["# connectd's dev keys (connectd init): local only, never commit. Deployed environments get their own.", ...Object.entries(keys).map(([k, v]) => `${k}=${v}`)]
      : []),
  ];
  if (lines.length) {
    if (before) appendFileSync(envFile, `${before.endsWith("\n") ? "" : "\n"}\n${lines.join("\n")}\n`);
    else writeFileSync(envFile, `${lines.join("\n")}\n`, { mode: 0o600 });
    // It holds keys now: owner only, even if others could read it before.
    if (Object.keys(keys).length)
      try {
        chmodSync(envFile, 0o600);
      } catch {
        log("  couldn't make .env owner only (chmod 600 .env): it holds keys now");
      }
    wrote.push(".env");
  } else kept.push(".env");

  // .env holds the keys now: never committed.
  if (!ignored(dir, ".env")) {
    const gi = join(dir, ".gitignore");
    const ignores = existsSync(gi) ? readFileSync(gi, "utf8") : "";
    appendFileSync(gi, `${ignores && !ignores.endsWith("\n") ? "\n" : ""}.env\n`);
    wrote.push(".gitignore");
  }

  // src/ when the app has one (Next's src/app), else the root.
  const src = existsSync(join(dir, "src")) ? join(dir, "src") : dir;
  const folders = relative(dir, join(src, "oc")).split("\\").join("/");
  const cloudflare = uses(dir, "@connectd/cloudflare");
  const name = (pkg(dir) as { name?: string } | null)?.name?.replace(/^@[^/]+\//, "") ?? "connectd";
  const config = CONFIG_FILES.map((f) => join(dir, f)).find((f) => existsSync(f));
  if (config) kept.push(relative(dir, config));
  else
    write(
      join(dir, CONFIG_FILES[0] as string),
      `import { defineConfig } from "@connectd/cli";
${cloudflare ? 'import { cloudflare } from "@connectd/cloudflare";\n' : ""}
// Your connections are the folders in ${folders}/ (\`connectd add github\` adds one). APP_URL, in .env, is
// your app's origin: where the connect flow returns and where events are posted (oc.routes).
export default defineConfig((env) => ({
  dir: "${folders}",
${cloudflare ? `  target: cloudflare({ name: ${JSON.stringify(name)} }),\n` : ""}  events: { url: \`\${env.APP_URL}/api/connectd/events\` },
  sessions: { origins: [env.APP_URL as string] },
}));
`,
    );
  mkdirSync(join(src, "oc"), { recursive: true });

  const client = join(src, "lib", "oc.ts");
  write(
    client,
    `import { connectd } from "@connectd/sdk";
import { listeners } from "${spec(client, join(workdir(dir), "app.ts"))}";

// CONNECTD_URL, CONNECTD_API_KEY and CONNECTD_EVENTS_SECRET come from .env (connectd init wrote them);
// in production, from your host's environment.
export const oc = connectd({
  // The signed-in user's id, from your auth (a session cookie, a header); null when nobody is signed in.
  // A user id can't contain ":" (it separates a user's accounts: "u1:work").
  user: async (req: Request) => null,
  // Each connection folder's events.ts.
  listeners,
  ...(process.env.APP_URL ? { origin: process.env.APP_URL } : {}),
});
`,
  );

  // Next.js (App Router): the route the config's events.url and the connect links use.
  const isNext = uses(dir, "next");
  // Next reads src/app only when the root has no app/ or pages/.
  const rootFirst = existsSync(join(dir, "app")) || existsSync(join(dir, "pages"));
  const appDir = rootFirst ? join(dir, "app") : join(src, "app");
  if (isNext) {
    const route = join(appDir, "api", "connectd", "[...path]", "route.ts");
    write(route, `import { oc } from "${spec(route, client)}";\n\n// connect/:def, return, events (oc.routes).\nexport const { GET, POST } = oc.routes;\n`);
  }

  // registry.d.ts and app.ts, so lib/oc.ts typechecks now. Needs the packages installed.
  let typed = false;
  try {
    await loadProject(dir, config ?? join(dir, CONFIG_FILES[0] as string), join(workdir(dir), "build"), Date.now(), { ...have, APP_URL: appUrl });
    typed = true;
  } catch {}

  const step = (cmd: string, what: string) => `  ${cmd.padEnd(24)}${what}`;
  const done = [
    wrote.length ? `wrote ${wrote.join(", ")}` : "nothing to write: already set up",
    kept.length ? `  kept ${kept.join(", ")} (already there)` : "",
    moved ? "  the keys from .connectd/dev.vars are in .env now (dev doesn't read it any more; deploy still refuses its values)" : "",
    o.appUrl !== undefined && have.APP_URL && have.APP_URL !== appUrl ? `  --app-url ignored: .env already has APP_URL=${have.APP_URL}` : "",
    o.port !== undefined && have.CONNECTD_URL ? `  --port ignored: .env already has CONNECTD_URL=${have.CONNECTD_URL}` : "",
    typed ? "" : "  run connectd types once the packages are installed (it writes .connectd/app.ts, which lib/oc.ts imports)",
  ];
  const next = [
    step("connectd add github", `a provider into ${folders}/ (\`connectd add\` lists them), then its env names in .env`),
    step(relative(dir, client), "return your signed-in user's id from user(req)"),
    isNext ? "" : step("oc.routes", "mount GET and POST at /api/connectd/* in your app (Express: toNode from @connectd/sdk/node)"),
    step("connectd dev", `the runtime on ${have.CONNECTD_URL || `http://localhost:${port}`}`),
    cloudflare ? "" : step("to deploy", "npm i -D @connectd/cloudflare, then target: cloudflare({ name }) in the config"),
  ];
  log([...done.filter(Boolean), "", "Next:", ...next.filter(Boolean)].join("\n"));
}
