import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve as resolvePath } from "node:path";
import type { DeployContext, Deployed, Env } from "@connectd/cli";
import { ENV, generateKeys } from "@connectd/cli/keys";
import { workdir } from "@connectd/cli/workdir";
import { type Generated, generate, publicUrl, workerName } from "./generate.ts";
import type { CloudflareOptions } from "./index.ts";

/**
 * The Cloudflare adapter (`target: cloudflare(...)`): the project into the user's own account,
 * through wrangler. The CLI has already chosen the production env and the secrets. Generated files
 * go to `.connectd/deploy/` (gitignored, rebuilt on every deploy, nothing secret in them);
 * secrets go to Cloudflare with the deployed version, through a 0600 temp file removed right after,
 * and nowhere else.
 */

/** Keys only the Worker holds: generated here, never read from a file, never printed. */
const GENERATED = [ENV.state, ENV.sessions, ENV.webhooks] as const;
/** The generated key each `--rotate` name replaces. */
const ROTATES: Record<string, string> = { [ENV.state]: "state", [ENV.sessions]: "sessions" };
/** The JSON array in a wrangler command's stdout (anything printed before it is skipped). */
const json = <T>(out: string) => JSON.parse(out.slice(Math.max(0, out.search(/^\s*\[/m)))) as T;

export const NO_WRANGLER = `connectd deploy runs wrangler, which isn't installed here:
  bun add -d wrangler     (or npm i -D wrangler)
  bunx wrangler login     (or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID)`;

/** Cloudflare's "no such Worker" (API error 10007), the only failure of `secret list` that means a new Worker. */
const NEW_WORKER = /\[code: 10007\]|does not exist on your account/;

type State = { name?: string; url?: string; databaseId?: string };

export { generate };
export type CloudflareDeployed = Deployed & { generated: Generated };

export async function deploy(o: DeployContext): Promise<CloudflareDeployed> {
  const { log, env, project, entry, secrets, rotate } = o;
  const opt = o.options as CloudflareOptions;
  const statePath = join(workdir(o.dir), "deploy", "state.json");
  const state: State = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, "utf8")) as State) : {};

  const name = workerName(o.name ?? opt.name ?? state.name ?? basename(resolvePath(o.dir)));
  const fixed = o.url ?? opt.url;
  let url = fixed ? publicUrl(fixed) : state.name === name ? state.url : undefined;
  const db = `${name}-index`;
  log(
    [
      `\nconnectd deploy ${name}${o.dryRun ? "  (dry run: nothing is sent to Cloudflare)" : ""}`,
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

  const bin = o.bin ?? env.CONNECTD_WRANGLER ?? (existsSync(join(o.dir, "node_modules", ".bin", "wrangler")) ? join(o.dir, "node_modules", ".bin", "wrangler") : "wrangler");
  const w = (args: string[]) => wrangler(bin, args, o.dir, env, log);

  // What the Worker already has: secrets are never rotated or regenerated unless asked.
  // Only Cloudflare's own "no such Worker" counts as new: anything else misread here would put fresh keys over live ones.
  const list = await w(["secret", "list", "--name", name, "--format", "json"]).catch((e: Error) => {
    if (NEW_WORKER.test(e.message)) return null;
    throw e;
  });
  if (list !== null && !url)
    throw new Error(
      `Worker ${name} exists, but its public URL isn't known here (.connectd/deploy/state.json from its first deploy is missing, e.g. in CI): pass --url https://${name}.<your-subdomain>.workers.dev (or its custom domain), or set cloudflare({ url }) in the config. Deploying without it would drop its CONNECTD_PUBLIC_URL.`,
    );
  const have = new Set(list === null ? [] : json<{ name: string }[]>(list).map((s) => s.name));
  if (project.events && !secrets[ENV.events] && !have.has(ENV.events))
    throw new Error(`events are on: set ${ENV.events}=whsec_<base64 of 32 random bytes> in .env.production (or --env-file, or the shell environment) and give the same value to your app`);

  const fresh = generateKeys();
  const push: Record<string, string> = { ...secrets };
  const versions = [...have].flatMap((k) => (k.startsWith(ENV.key) ? [Number(k.slice(ENV.key.length))] : [])).filter(Number.isInteger);
  if (!versions.length) push[`${ENV.key}1`] = fresh[`${ENV.key}1`] as string;
  else if (rotate.includes("key")) push[`${ENV.key}${Math.max(...versions) + 1}`] = fresh[`${ENV.key}1`] as string;
  for (const k of GENERATED) if (!have.has(k) || rotate.includes(ROTATES[k] ?? "")) push[k] = fresh[k] as string;
  // Never in CI: there the key comes from a CI secret (the CLI checked it's in `secrets`).
  const newApiKey = !o.ci && !secrets[ENV.apiKey] && (!have.has(ENV.apiKey) || rotate.includes("api-key")) ? (fresh[ENV.apiKey] as string) : undefined;
  if (newApiKey) push[ENV.apiKey] = newApiKey;

  // The index database: found by name, so a deploy from another machine finds the same one.
  const find = async () => json<{ uuid: string; name: string }[]>(await w(["d1", "list", "--json"])).find((d) => d.name === db)?.uuid;
  let databaseId = await find();
  // A database without its Worker: the Worker was deleted (its keys with it), or an earlier deploy
  // stopped in between. Either way fresh keys can't open anything sealed before; say so first.
  if (databaseId && list === null && !o.newKeys)
    throw new Error(
      `D1 database ${db} exists but Worker ${name} doesn't. Fresh keys can't open credentials sealed under the old ones. If an earlier deploy stopped before creating the Worker, or you mean to start over, re-run with --new-keys; to keep old connections, restore the Worker's secrets first.`,
    );
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
  } catch (e) {
    const hint = newApiKey
      ? `\nThe new API key was not shown. If the deploy went through anyway (wrangler secret list --name ${name} shows ${ENV.apiKey}), re-run with --rotate api-key to get one you can see.`
      : "";
    throw new Error(`${(e as Error).message}${hint}`);
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
      ...(project.dashboard === false ? [] : [`  dashboard     ${url}/dashboard   (sign in with the API key)`]),
      `  secrets set   ${Object.keys(push).sort().join(", ") || "none (all present)"}`,
    ].join("\n"),
  );
  return { name, url, dryRun: false as const, generated: g, pushed: Object.keys(push), apiKey: newApiKey };
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
