import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve as resolvePath } from "node:path";
import type { DeployContext, Deployed, Env, SetupContext } from "@kavishkagaya/connectd";
import { ENV } from "@kavishkagaya/connectd/keys";
import { workdir } from "@kavishkagaya/connectd/workdir";
import { type Generated, generate, publicUrl, workerName } from "./generate.ts";
import type { CloudflareOptions } from "./index.ts";

/**
 * The Cloudflare adapter (`target: cloudflare(...)`): the project into the user's own account,
 * through wrangler. The CLI has already chosen the production env and the secrets. Generated files
 * go to `.connectd/deploy/` (gitignored, rebuilt on every deploy, nothing secret in them);
 * secrets go to Cloudflare with the deployed version, through a 0600 temp file removed right after,
 * and nowhere else.
 */

/** The JSON array in a wrangler command's stdout (anything printed before it is skipped). */
const json = <T>(out: string) => JSON.parse(out.slice(Math.max(0, out.search(/^\s*\[/m)))) as T;

export const NO_WRANGLER = `connectd deploy runs wrangler, which isn't installed here:
  npm i -D wrangler       (or bun add -d, pnpm add -D, yarn add -D)
  npx wrangler login      (or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID)`;

export const NOT_LOGGED_IN = `wrangler isn't logged in to Cloudflare:
  npx wrangler login      (opens your browser; --browser=false prints the link)
  in CI: set CLOUDFLARE_API_TOKEN (Workers Scripts, D1: edit) and CLOUDFLARE_ACCOUNT_ID`;

/** wrangler: `bin` (tests), CONNECTD_WRANGLER, the project's own, else one on PATH; null when there's none. */
function findWrangler(o: Pick<SetupContext, "dir" | "env" | "bin">): string | null {
  if (o.bin) return o.bin;
  if (o.env.CONNECTD_WRANGLER) return o.env.CONNECTD_WRANGLER;
  const own = join(o.dir, "node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler");
  if (existsSync(own)) return own;
  // On the PATH the deploy runs with (its env), as whoami and deploy will run it.
  return spawnSync("wrangler", ["--version"], { stdio: "ignore", env: o.env as NodeJS.ProcessEnv, shell: process.platform === "win32" }).error ? null : "wrangler";
}

/** Who wrangler is signed in as, or null. */
function whoami(bin: string, o: Pick<SetupContext, "dir" | "env">): string | null {
  const r = spawnSync(bin, ["whoami"], { cwd: o.dir, env: o.env as NodeJS.ProcessEnv, encoding: "utf8", shell: process.platform === "win32" });
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") throw new Error(NO_WRANGLER);
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.status !== 0 || !/You are logged in/i.test(out)) return null;
  return /associated with the email (\S+?)\.?\s/.exec(out)?.[1] ?? (/API Token/i.test(out) ? "an API token" : "your account");
}

/**
 * wrangler installed and signed in (`connectd init` after installing the target, and every deploy).
 * At a terminal it offers the install and `wrangler login`; elsewhere (CI) it says what to do.
 * Returns the binary to run.
 */
async function ready(o: SetupContext): Promise<string> {
  let bin = findWrangler(o);
  if (!bin) {
    if (!o.prompts || !(await o.prompts.confirm("Cloudflare deploys go through wrangler, which isn't installed in this project. Install it now?"))) throw new Error(NO_WRANGLER);
    if (!o.install(["wrangler"]) || !(bin = findWrangler(o))) throw new Error(`installing wrangler didn't work\n${NO_WRANGLER}`);
  }
  let who = whoami(bin, o);
  if (!who) {
    if (o.env.CLOUDFLARE_API_TOKEN) throw new Error(`wrangler can't sign in with CLOUDFLARE_API_TOKEN: check the token (\`npx wrangler whoami\` says why)`);
    if (!o.prompts || !(await o.prompts.confirm("wrangler isn't logged in to Cloudflare. Log in now (opens your browser)?"))) throw new Error(NOT_LOGGED_IN);
    spawnSync(bin, ["login"], { cwd: o.dir, env: o.env as NodeJS.ProcessEnv, stdio: "inherit", shell: process.platform === "win32" });
    if (!(who = whoami(bin, o))) throw new Error(NOT_LOGGED_IN);
  }
  o.log(`  cloudflare   wrangler, logged in as ${who}`);
  return bin;
}

/** The target's setup: wrangler installed and logged in. */
export async function setup(o: SetupContext): Promise<void> {
  await ready(o);
}

/**
 * Cloudflare's "no such Worker", the only failure of `secret list` that means a new Worker: API
 * error 10007 (older wranglers print it), or `Worker "<name>" not found.` (wrangler 4.15x).
 */
const newWorker = (name: string, message: string) => /\[code: 10007\]|does not exist on your account/.test(message) || message.includes(`Worker "${name}" not found`);

type State = { name?: string; url?: string; databaseId?: string };

export { generate };
export type CloudflareDeployed = Deployed & { generated: Generated };

export async function deploy(o: DeployContext): Promise<CloudflareDeployed> {
  const { log, env, project, entry, secrets, rotate } = o;
  const opt = o.options as CloudflareOptions;
  // Each environment is its own Worker and database (`<name>-staging`), with its own state file;
  // production keeps the plain name (and state.json, as before environments).
  const prod = o.environment === "production";
  const per = prod ? {} : (opt.environments?.[o.environment] ?? {});
  const statePath = join(workdir(o.dir), "deploy", prod ? "state.json" : `state.${o.environment}.json`);
  const state: State = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, "utf8")) as State) : {};

  const suffix = prod ? "" : `-${o.environment}`;
  const name = workerName(o.name ?? per.name ?? (opt.name ? opt.name + suffix : (state.name ?? basename(resolvePath(o.dir)) + suffix)));
  const fixed = o.url ?? (prod ? opt.url : per.url);
  let url = fixed ? publicUrl(fixed) : state.name === name ? state.url : undefined;
  const db = `${name}-index`;
  log(
    [
      `\nconnectd deploy ${name} (${o.environment})${o.dryRun ? "  (dry run: nothing is sent to Cloudflare)" : ""}`,
      `  public URL   ${url ?? "the workers.dev URL (read from the first deploy, then deployed again with it)"}`,
      ...o.summary,
      "  steps        wrangler secret list · d1 list (create if missing) · d1 migrations apply --remote · deploy --secrets-file (0600 temp file)",
    ].join("\n"),
  );

  if (o.dryRun) {
    const g = generate({ dir: o.dir, config: entry, name, ...(url ? { url } : {}), ...(state.databaseId && state.name === name ? { databaseId: state.databaseId } : {}) });
    log(`  wrote        ${relative(o.dir, g.entry)}, ${relative(o.dir, g.wrangler)}, ${relative(o.dir, g.migrations)}/`);
    return { name, url, dryRun: true as const, generated: g };
  }

  const bin = await ready(o);
  const w = (args: string[]) => wrangler(bin, args, o.dir, env, log);

  // What the Worker already has: how many encryption key versions it holds.
  // Only Cloudflare's own "no such Worker" counts as new.
  const list = await w(["secret", "list", "--name", name, "--format", "json"]).catch((e: Error) => {
    if (newWorker(name, e.message)) return null;
    throw e;
  });
  if (list !== null && !url)
    throw new Error(
      `Worker ${name} exists, but its public URL isn't known here (.connectd/deploy/state.json from its first deploy is missing, e.g. in CI): pass --url https://${name}.<your-subdomain>.workers.dev (or its custom domain), or set cloudflare({ url }) in the config. Deploying without it would drop its CONNECTD_PUBLIC_URL.`,
    );
  const have = new Set(list === null ? [] : json<{ name: string }[]>(list).map((s) => s.name));

  // The deployment's keys derive from the root key (#86). Only the ones the Worker doesn't have yet
  // are sent: a key it holds is never replaced, so a redeploy (even from a wrong root key) can't
  // strand what was sealed under it. --rotate key adds one encryption key version; older ones stay.
  // ponytail: the version count is read from the Worker's secret names; a deleted Worker forgets it
  // (V1 comes back): pass --rotate key once per lost version to restore them.
  const versions = [...have].flatMap((k) => (k.startsWith(ENV.key) ? [Number(k.slice(ENV.key.length))] : [])).filter(Number.isInteger);
  const top = Math.max(1, ...versions) + (rotate.includes("key") && versions.length ? 1 : 0);
  const derived = Object.entries(await o.keys(top)).filter(([k]) => !have.has(k));
  const push: Record<string, string> = { ...secrets, ...Object.fromEntries(derived) };

  // The index database: found by name, so a deploy from another machine finds the same one.
  const find = async () => json<{ uuid: string; name: string }[]>(await w(["d1", "list", "--json"])).find((d) => d.name === db)?.uuid;
  let databaseId = await find();
  // A database without its Worker (deleted, or an earlier deploy stopped in between): the derived keys come back with it.
  if (databaseId && list === null) log(`  D1 database ${db} exists without Worker ${name}: deploying it again with the same derived keys`);
  if (!databaseId) {
    await w(["d1", "create", db]);
    databaseId = await find();
    if (!databaseId) throw new Error(`created D1 database ${db} but can't find it in wrangler d1 list`);
  }

  let g = generate({ dir: o.dir, config: entry, name, ...(url ? { url } : {}), databaseId });
  await w(["d1", "migrations", "apply", db, "--remote", "--config", g.wrangler]);

  // Secrets go up with the version (`--secrets-file`), so new code never runs without them. Wrangler
  // reads them from a file only: a 0600 file in a fresh temp dir, removed right after. Never argv.
  const tmp = mkdtempSync(join(tmpdir(), "connectd-"));
  let child: ChildProcess | undefined;
  // A signal skips `finally`: remove the secrets first, stop wrangler, and exit non-zero.
  const abort = (sig: NodeJS.Signals) => {
    rmSync(tmp, { recursive: true, force: true });
    child?.kill(sig);
    process.exit(sig === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  let out: string;
  try {
    const args = ["deploy", "--config", g.wrangler];
    if (Object.keys(push).length) {
      writeFileSync(join(tmp, "secrets.json"), JSON.stringify(push), { mode: 0o600 });
      args.push("--secrets-file", join(tmp, "secrets.json"));
    }
    out = await wrangler(bin, args, o.dir, env, log, (p) => (child = p));
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
    rmSync(tmp, { recursive: true, force: true });
  }
  if (!url) {
    // A new Worker (an existing one needs its URL known, above). ponytail: the workers.dev subdomain
    // is only known from wrangler's output, so the first deploy goes out without CONNECTD_PUBLIC_URL
    // and a second one sets it; state.json remembers it.
    const deployed = /https:\/\/[a-z0-9.-]+\.workers\.dev/.exec(out)?.[0];
    if (!deployed) throw new Error("wrangler deploy printed no workers.dev URL; pass --url");
    url = deployed;
    g = generate({ dir: o.dir, config: entry, name, url, databaseId });
    await w(["deploy", "--config", g.wrangler]);
  }
  writeFileSync(statePath, `${JSON.stringify({ name, url, databaseId } satisfies State, null, 2)}\n`);

  log(
    [
      `\ndeployed ${name}`,
      `  URL           ${url}`,
      `  callback URL  ${url}/callback   (register this redirect URI with each OAuth provider)`,
      `  webhooks      ${url}/webhooks/:def[/:id]`,
      ...(project.dashboard === false ? [] : [`  dashboard     ${url}/dashboard`]),
      `  secrets set   ${Object.keys(push).sort().join(", ")}`,
    ].join("\n"),
  );
  return { name, url, dryRun: false as const, generated: g, pushed: Object.keys(push) };
}

/** Run wrangler; resolves to its stdout, rejects with stdout + stderr on a non-zero exit. Output is echoed except listings (it never holds a secret: those only go in through a file). */
function wrangler(bin: string, args: string[], cwd: string, env: Env, log: (s: string) => void, spawned?: (p: ChildProcess) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { cwd, env: env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
    spawned?.(p);
    let out = "";
    let all = "";
    p.stdout?.on("data", (b: Buffer) => ((out += b.toString()), (all += b.toString())));
    p.stderr?.on("data", (b: Buffer) => (all += b.toString()));
    p.on("error", (e: NodeJS.ErrnoException) => reject(e.code === "ENOENT" ? new Error(NO_WRANGLER) : e));
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`wrangler ${args.slice(0, 3).join(" ")} failed (${code}):\n${all.trimEnd()}`));
      if (!args.includes("list") && all.trim()) log(all.trimEnd().replace(/^/gm, "  | "));
      resolve(out);
    });
  });
}
