import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parseEnv } from "./env.ts";
import { ENV, newRootKey } from "./keys.ts";
import { CONFIG_FILES, loadProject } from "./load.ts";
import { add, catalog } from "./add.ts";
import { loadAdapter } from "./deploy.ts";
import { interactive, type Prompts, terminal } from "./prompt.ts";
import { workdir } from "./workdir.ts";

/** dev's default port (dev.ts imports the runtime; this file stays light). */
const PORT = 8787;

/**
 * `connectd init` (#54): sets up dev, the one explicit step that makes the root key. In the app's
 * directory it writes, never overwriting what's there:
 *
 *   .env               the project's root key (CONNECTD_ROOT_KEY, #86: every environment's keys
 *                      derive from it), CONNECTD_URL (where dev runs) and APP_URL (the app's origin):
 *                      the one file the app and connectd share. `connectd dev` adds the app's dev
 *                      API key (and events secret) itself.
 *   .gitignore         `.env`, since it holds the root key now
 *   oc.config.ts       sessions.origins and events.url from env.APP_URL; connections in <src>/oc/;
 *                      the deploy target (`--target`, asked in a terminal), its packages installed
 *   <src>/lib/oc.ts    the client: connectd({ user, listeners })
 *   app/api/connectd/[...path]/route.ts   oc.routes, for a Next.js app (App Router)
 *
 * The root key is made once and never changes: a teammate copies it into their .env, CI holds it as
 * a secret. init never overwrites one.
 */

/**
 * Where the runtime runs: what `init --target` installs and writes into the config. Packages are
 * installed with the project's package manager. A Node server target joins this list later.
 */
export const TARGETS = {
  cloudflare: {
    label: "Cloudflare Workers",
    packages: ["@kavishkagaya/connectd-cloudflare", "wrangler"],
    adapter: "@kavishkagaya/connectd-cloudflare/adapter",
    import: 'import { cloudflare } from "@kavishkagaya/connectd-cloudflare";',
    call: (name: string) => `cloudflare({ name: ${JSON.stringify(name)} })`,
    next: "to your Cloudflare account (it checks wrangler is logged in first)",
  },
} as const;
export type TargetName = keyof typeof TARGETS;

export type InitOptions = {
  dir: string;
  port?: number;
  appUrl?: string;
  /** The deploy target, or "none". Default: asked in a terminal; else the one already installed, else none. */
  target?: TargetName | "none";
  /** Catalog providers to add (`--add github,slack`). Default: picked from a checklist in a terminal, else none. */
  providers?: string[];
  /** Don't install anything (only write the files). */
  skipInstall?: boolean;
  /** No questions: flags, then what's in .env, then the defaults (`--yes`; always so in CI). */
  yes?: boolean;
  /** The setup's questions (tests pass their own). Default: the terminal's when a person is at it. */
  prompts?: Prompts;
  /** The provider catalog (`connectd add`'s): tests point it at a folder. */
  registry?: string;
  env?: Record<string, string | undefined>;
  /** Runs the install command; resolves to its exit code (tests pass one). */
  run?: (cmd: string, args: string[], cwd: string) => number;
  log?: (line: string) => void;
  /** The runtime's versions (default `process.versions`): tests pass an old Node. */
  versions?: { node?: string; bun?: string };
};

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

/**
 * The package manager the project uses: its lockfile's (`npx connectd` in a pnpm project is still
 * pnpm's), else the one running us (npx, pnpm dlx, bunx, yarn), else npm.
 */
export function packageManager(dir: string, agent = process.env.npm_config_user_agent ?? ""): "npm" | "pnpm" | "yarn" | "bun" {
  if (existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb"))) return "bun";
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn";
  if (existsSync(join(dir, "package-lock.json"))) return "npm";
  return (/^(npm|pnpm|yarn|bun)\//.exec(agent)?.[1] as "npm" | "pnpm" | "yarn" | "bun" | undefined) ?? "npm";
}

/** The install command for `packages`: dev dependencies, or (`dev` false) the app's own. */
export const installCommand = (pm: ReturnType<typeof packageManager>, packages: string[], dev = true): [string, string[]] =>
  pm === "npm" ? ["npm", ["install", ...(dev ? ["-D"] : []), ...packages]] : pm === "bun" ? ["bun", ["add", ...(dev ? ["-d"] : []), ...packages]] : [pm, ["add", ...(dev ? ["-D"] : []), ...packages]];

const cliVersion = () => (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

/**
 * What to install for a package: ours at this CLI's version (`@^0.3.0`; the workspace's 0.0.0:
 * whatever resolves), or from `CONNECTD_TARBALLS` (a folder of `bun run pack`'s tarballs: a local
 * build, for the e2e walkthrough); anything else as named.
 */
export function packageSpec(name: string, env: Record<string, string | undefined> = process.env): string {
  if (!name.startsWith("@kavishkagaya/")) return name;
  const version = cliVersion();
  const dir = env.CONNECTD_TARBALLS;
  if (dir) {
    const file = join(dir, `${name.slice(1).replace("/", "-")}-${version}.tgz`);
    if (!existsSync(file)) throw new Error(`CONNECTD_TARBALLS: no ${file} (bun run pack makes it)`);
    return file;
  }
  return version === "0.0.0" ? name : `${name}@^${version}`;
}

/** Installs with the project's package manager, the output on the terminal; false when it failed. `run` replaces the spawn (tests). */
export function installer(dir: string, log: (line: string) => void, run?: (cmd: string, args: string[], cwd: string) => number, env: Record<string, string | undefined> = process.env) {
  return (packages: string[], dev = true): boolean => {
    const [cmd, args] = installCommand(packageManager(dir), packages.map((p) => packageSpec(p, env)), dev);
    log(`installing ${packages.join(", ")}: ${cmd} ${args.join(" ")}`);
    const code = (run ?? ((c, a, cwd) => spawnSync(c, a, { cwd, stdio: "inherit", shell: process.platform === "win32" }).status ?? 1))(cmd, args, dir);
    if (code !== 0) log(`  the install failed: run ${cmd} ${args.join(" ")} yourself`);
    return code === 0;
  };
}

/** `import x from "<from → to>"`, without the extension (as Next and TS resolve it). */
const spec = (from: string, to: string) => {
  const r = relative(dirname(from), to).split("\\").join("/").replace(/\.ts$/, "");
  return r.startsWith(".") ? r : `./${r}`;
};

/** Popular first in the checklist; the rest of the catalog after them. */
const POPULAR = ["github", "google", "slack"];

/**
 * Said before anything installs: `connectd dev` needs `node:sqlite` (Node 22.5+) or Bun, and wrangler
 * Node 22, so an older Node would only fail later, at `connectd dev`. Null when the runtime is fine.
 */
export function oldNode(versions: { node?: string; bun?: string } = process.versions): string | null {
  if (versions.bun || !versions.node) return null;
  const [major = 0, minor = 0] = versions.node.split(".").map(Number);
  if (major > 22 || (major === 22 && minor >= 5)) return null;
  return `this is Node ${versions.node}: connectd dev needs Node 22.5 or later (or Bun), and wrangler Node 22. Switch (nvm install 22) before connectd dev`;
}

export async function init(o: InitOptions): Promise<void> {
  const log = o.log ?? console.log;
  const dir = o.dir;
  const env = o.env ?? process.env;
  const ask = o.yes ? undefined : (o.prompts ?? (interactive() ? terminal : undefined));
  const install = installer(dir, log, o.run, env);
  let n = 0;
  const q = (s: string) => `\n${++n}. ${s}`;
  const here = relative(process.cwd(), dir);
  if (ask) log(`connectd init: set up connectd in ${!here ? "this folder" : here.startsWith("..") ? dir : here}  (Enter keeps the default)`);
  const old = oldNode(o.versions);
  if (old) log(`note: ${old}`);
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
  let asked: string | undefined;
  if (ask && o.appUrl === undefined && !have.APP_URL) asked = await ask.text(q("Your app's origin in dev (where your app runs; connect flows return there, events go there)"), "http://localhost:3000");
  let port = o.port ?? PORT;
  if (ask && o.port === undefined && !have.CONNECTD_URL)
    for (;;) {
      const p = Number(await ask.text(q("Port for connectd dev (your app calls it there)"), String(PORT)));
      if (Number.isInteger(p) && p > 0 && p < 65536) {
        port = p;
        break;
      }
      log("  a port number, 1 to 65535");
    }
  const from = o.appUrl !== undefined ? "--app-url" : have.APP_URL ? "APP_URL in .env" : asked ? "your app's origin" : "APP_URL";
  const appUrl = (o.appUrl ?? have.APP_URL ?? asked ?? "http://localhost:3000").replace(/\/+$/, "");
  let origin: string | null = null;
  try {
    origin = new URL(appUrl).origin;
  } catch {}
  if (origin !== appUrl || !/^https?:/.test(appUrl)) throw new Error(`${from} must be an origin like http://localhost:3000 (${appUrl})`);
  const root = have[ENV.root] ? null : newRootKey();
  // Ignore rules don't apply to a tracked file: a key written there would go out with the next commit.
  if (root && spawnSync("git", ["ls-files", "--error-unmatch", ".env"], { cwd: dir }).status === 0)
    throw new Error("`.env` is tracked by git, so the root key would be committed: `git rm --cached .env`, commit, then connectd init again");
  const lines = [
    ...(have.APP_URL ? [] : ["# Your app's origin: oc.config.ts builds sessions.origins and events.url from it.", `APP_URL=${appUrl}`]),
    ...(have.CONNECTD_URL ? [] : ["# Where `connectd dev` runs: the app's client calls it.", `CONNECTD_URL=http://localhost:${port}`]),
    ...(root
      ? [
          "# The project's root key (connectd init): every environment's keys derive from it, and it never",
          "# changes. Never commit it; keep a copy in your password manager, give CI the same one as a secret.",
          `${ENV.root}=${root}`,
        ]
      : []),
  ];
  if (lines.length) {
    if (before) appendFileSync(envFile, `${before.endsWith("\n") ? "" : "\n"}\n${lines.join("\n")}\n`);
    else writeFileSync(envFile, `${lines.join("\n")}\n`, { mode: 0o600 });
    // It holds the root key now: owner only, even if others could read it before.
    if (root)
      try {
        chmodSync(envFile, 0o600);
      } catch {
        log("  couldn't make .env owner only (chmod 600 .env): it holds the root key now");
      }
    wrote.push(".env");
  } else kept.push(".env");

  // .env holds the root key now: never committed.
  if (!ignored(dir, ".env")) {
    const gi = join(dir, ".gitignore");
    const ignores = existsSync(gi) ? readFileSync(gi, "utf8") : "";
    appendFileSync(gi, `${ignores && !ignores.endsWith("\n") ? "\n" : ""}.env\n`);
    wrote.push(".gitignore");
  }

  // src/ when the app has one (Next's src/app), else the root.
  const src = existsSync(join(dir, "src")) ? join(dir, "src") : dir;
  const folders = relative(dir, join(src, "oc")).split("\\").join("/");
  const name = (pkg(dir) as { name?: string } | null)?.name?.replace(/^@[^/]+\//, "") ?? "connectd";
  const config = CONFIG_FILES.map((f) => join(dir, f)).find((f) => existsSync(f));

  // The package the app imports (its SDK) and the CLI runs from: a dependency of the app.
  let installFailed = "";
  const CORE = "@kavishkagaya/connectd";
  if (!o.skipInstall && !uses(dir, CORE) && (!ask || (await ask.confirm(q(`Install ${CORE} (your app imports its SDK; the connectd CLI comes with it)?`)))))
    if (!install([CORE], false)) installFailed = CORE;

  // The deploy target: --target, else asked in a terminal, else the one already installed. Only for a
  // new config (an existing one keeps its target).
  const installed = (Object.keys(TARGETS) as TargetName[]).find((t) => uses(dir, TARGETS[t].packages[0]));
  let chosen: TargetName | "none" = "none";
  // Installs only for a target chosen now (--target or the prompt), not one found installed.
  let chosenNow = false;
  if (!config) {
    if (o.target) (chosen = o.target), (chosenNow = true);
    else if (installed) chosen = installed;
    else if (ask) {
      const choices = (Object.keys(TARGETS) as TargetName[]).map((t) => ({ value: t, label: `${TARGETS[t].label}  (installs ${TARGETS[t].packages.join(" and ")})` }));
      chosen = (await ask.choose(q("Where will connectd run when you deploy?"), [...choices, { value: "none", label: "Decide later" }])) as TargetName | "none";
      chosenNow = true;
    }
  }
  const target = chosen === "none" ? undefined : chosen;
  if (target && chosenNow && !o.skipInstall) {
    const missing = TARGETS[target].packages.filter((p) => !uses(dir, p));
    if (missing.length && !install(missing)) installFailed = missing.join(", ");
    // The target's own tool, signed in now while someone's here (Cloudflare: `wrangler login`); deploy checks again.
    else if (ask)
      try {
        const adapter = await loadAdapter(dir, TARGETS[target].adapter);
        await adapter.setup?.({ dir, env, log, prompts: ask, install });
      } catch (e) {
        log(`  ${(e as Error).message.split("\n").join("\n  ")}\n  (connectd deploy asks again)`);
      }
  }

  if (config) kept.push(relative(dir, config));
  else
    write(
      join(dir, CONFIG_FILES[0] as string),
      `import { defineConfig } from "@kavishkagaya/connectd";
${target ? `${TARGETS[target].import}\n` : ""}
// Your connections are the folders in ${folders}/ (\`connectd add github\` adds one). APP_URL, in .env, is
// your app's origin: where the connect flow returns and where events are posted (oc.routes).
export default defineConfig((env) => ({
  dir: "${folders}",
${target ? `  target: ${TARGETS[target].call(name)},\n` : ""}  events: { url: \`\${env.APP_URL}/api/connectd/events\` },
  sessions: { origins: [env.APP_URL as string] },
}));
`,
    );
  mkdirSync(join(src, "oc"), { recursive: true });

  const client = join(src, "lib", "oc.ts");
  write(
    client,
    `import { connectd } from "@kavishkagaya/connectd/sdk";
import { listeners } from "${spec(client, join(workdir(dir), "app.ts"))}";

// CONNECTD_URL, CONNECTD_API_KEY and CONNECTD_EVENTS_SECRET come from .env (connectd dev writes the keys);
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

  // Providers: --add, else a checklist in a terminal (popular first; "Add later"). Each is `connectd add <id>`.
  let picked = o.providers ?? [];
  const reg = { dir, env, ...(o.registry ? { registry: o.registry } : {}) };
  if (!o.providers && ask)
    try {
      const all = await catalog(reg);
      const ordered = [...POPULAR.flatMap((id) => all.filter((e) => e.id === id)), ...all.filter((e) => !POPULAR.includes(e.id))];
      picked = await ask.checklist(q(`Providers to add (each becomes a folder in ${folders}/, yours to edit)`), [
        ...ordered.map((e) => ({ value: e.id, label: e.id, hint: e.description })),
        { value: "", label: "Add later", hint: "connectd add <provider>, or --custom for your own", alone: true },
      ]);
    } catch (e) {
      log(`  couldn't read the provider catalog (${(e as Error).message}): \`connectd add\` lists it later`);
    }
  const added: string[] = [];
  for (const id of picked)
    try {
      // add's first line only (what it wrote): its install hint is init's job, done above.
      const said: string[] = [];
      await add({ ...reg, log: (l) => void said.push(l), provider: id, folders: join(src, "oc") });
      log(said[0]?.split("\n")[0] ?? `added ${id}`);
      added.push(id);
    } catch (e) {
      log(`  ${id}: ${(e as Error).message}`);
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
    root ? `  ${ENV.root} is in .env: keep a copy in your password manager (it can't be recovered); CI needs it as a secret` : "",
    o.appUrl !== undefined && have.APP_URL && have.APP_URL !== appUrl ? `  --app-url ignored: .env already has APP_URL=${have.APP_URL}` : "",
    o.port !== undefined && have.CONNECTD_URL ? `  --port ignored: .env already has CONNECTD_URL=${have.CONNECTD_URL}` : "",
    installFailed ? `  installing ${installFailed} failed: its command is above, run it yourself` : "",
    typed ? "" : "  run connectd types once the packages are installed (it writes .connectd/app.ts, which lib/oc.ts imports)",
  ];
  const next = [
    added.length
      ? step(".env", `fill in the client id and secret for ${added.join(", ")} (the names are there, empty)`)
      : step("connectd add github", `a provider into ${folders}/ (\`connectd add\` lists them), then its env names in .env`),
    step(relative(dir, client), "return your signed-in user's id from user(req)"),
    isNext ? "" : step("oc.routes", "mount GET and POST at /api/connectd/* in your app (Express: toNode from @kavishkagaya/connectd/sdk/node)"),
    step("connectd dev", `the runtime on ${have.CONNECTD_URL || `http://localhost:${port}`}`),
    target
      ? step("connectd deploy", TARGETS[target].next)
      : config
        ? ""
        : step("to deploy", `${installCommand(packageManager(dir), [...TARGETS.cloudflare.packages]).flat().join(" ")}, then target: cloudflare({ name }) in the config`),
  ];
  log([...done.filter(Boolean), "", "Next:", ...next.filter(Boolean)].join("\n"));
}
