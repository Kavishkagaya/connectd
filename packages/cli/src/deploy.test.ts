import { parseEnv } from "./env.ts";
import { afterAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "./cli.ts";
import { type CloudflareDeployed, generate, NO_WRANGLER } from "@kavishkagaya/connectd-cloudflare/adapter";
import { deploy, type DeployOptions } from "./deploy.ts";
import { loadProject } from "./load.ts";

const TMP = join(import.meta.dir, "..", ".tmp-deploy");
mkdirSync(TMP, { recursive: true });
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

/**
 * A fake wrangler: records argv of every call (and a --secrets-file's content and mode), and keeps a fake account (D1 databases,
 * secrets by Worker) in a JSON file, enough to answer the commands deploy runs.
 */
const FAKE = `#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
const [log, path] = [process.env.FAKE_LOG, process.env.FAKE_ACCOUNT];
const argv = process.argv.slice(2);
const sf = argv.includes("--secrets-file") ? argv[argv.indexOf("--secrets-file") + 1] : null;
const secrets = sf ? { body: readFileSync(sf, "utf8"), mode: statSync(sf).mode & 0o777 } : null;
appendFileSync(log, JSON.stringify({ argv, secrets }) + "\\n");
const a = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { dbs: [], workers: {} };
const save = () => writeFileSync(path, JSON.stringify(a));
const opt = (n) => argv[argv.indexOf(n) + 1];
console.error("▲ [WARNING] Proxy environment variables detected.");
if (process.env.FAKE_FAIL === argv.slice(0, 2).join(" ")) { console.error(process.env.FAKE_ERROR ?? "boom"); process.exit(1); }
const [c1, c2] = argv;
if (c1 === "secret" && c2 === "list") {
  const w = a.workers[opt("--name")];
  if (!w) { console.error("This Worker does not exist on your account. [code: 10007]"); process.exit(1); }
  console.log(JSON.stringify(Object.keys(w.secrets).map((name) => ({ name, type: "secret_text" }))));
} else if (c1 === "d1" && c2 === "list") console.log(JSON.stringify(a.dbs));
else if (c1 === "d1" && c2 === "create") { a.dbs.push({ uuid: "db-" + a.dbs.length, name: argv[2] }); save(); console.log("Created"); }
else if (c1 === "d1" && c2 === "migrations") console.log("Migrations applied");
else if (c1 === "deploy") {
  if (process.env.FAKE_SLEEP && argv.includes("--secrets-file")) await Bun.sleep(30000);
  const cfg = JSON.parse(readFileSync(opt("--config"), "utf8"));
  // Like wrangler without keep_vars: the config's vars replace the deployed ones; secrets are additive.
  a.workers[cfg.name] ??= { secrets: {} }; a.workers[cfg.name].vars = cfg.vars;
  a.workers[cfg.name].history = [...(a.workers[cfg.name].history ?? []), cfg.vars];
  if (secrets) Object.assign(a.workers[cfg.name].secrets, JSON.parse(secrets.body));
  save();
  console.log("Uploaded " + cfg.name + "\\n  https://" + cfg.name + ".acct.workers.dev\\nCurrent Version ID: 1");
} else { console.error("fake wrangler: unknown command"); process.exit(1); }
`;

const CONFIG = (events = false, target = "cloudflare()") => `import { apiKey, defineConnection, oauth2 } from "@kavishkagaya/connectd-connections";
import { cloudflare } from "@kavishkagaya/connectd-cloudflare";
export default (env) => ({
  target: ${target},
  definitions: [
    defineConnection({ id: "keyed", auth: apiKey(["key"]) }),
    defineConnection({ id: "gh", auth: oauth2({ authorizeUrl: "https://p.test/a", tokenUrl: "https://p.test/t" }) }),
  ],
  config: env.GH_ID ? { gh: { clientId: env.GH_ID, clientSecret: env.GH_SECRET } } : {},
  ${events ? `events: { url: "https://app.test/events" },` : ""}
});
`;

function setup(o: { events?: boolean; vars?: string; target?: string } = {}) {
  const dir = mkdtempSync(join(TMP, "my app-"));
  writeFileSync(join(dir, "oc.config.ts"), CONFIG(o.events, o.target));
  writeFileSync(join(dir, ".prod.vars"), o.vars ?? "GH_ID=prod-id\nGH_SECRET=prod-secret\n");
  const bin = join(dir, "wrangler-fake");
  writeFileSync(bin, FAKE);
  chmodSync(bin, 0o755);
  const env = { ...process.env, FAKE_LOG: join(dir, "calls.jsonl"), FAKE_ACCOUNT: join(dir, "account.json") } as Record<string, string>;
  const lines: string[] = [];
  let n = 0;
  const run = (x: Partial<DeployOptions> = {}) =>
    (deploy as (o: DeployOptions) => Promise<CloudflareDeployed>)({
      dir,
      load: (env) => loadProject(dir, join(dir, "oc.config.ts"), join(dir, ".connectd", "build"), ++n, env),
      envFile: ".prod.vars",
      wrangler: bin,
      env,
      log: (l) => void lines.push(l),
      ...x,
    });
  const calls = () =>
    existsSync(env.FAKE_LOG!)
      ? readFileSync(env.FAKE_LOG!, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l) as { argv: string[]; secrets: { body: string; mode: number } | null })
      : [];
  const account = () => JSON.parse(readFileSync(env.FAKE_ACCOUNT!, "utf8")) as { dbs: { name: string }[]; workers: Record<string, { secrets: Record<string, string>; vars: Record<string, string>; history: Record<string, string>[] }> };
  return { dir, run, calls, account, lines, env, reset: () => rmSync(env.FAKE_LOG!, { force: true }) };
}

const cmd = (c: { argv: string[] }) => c.argv.filter((a) => !a.includes("/")).join(" ");

test("first deploy: D1 created, migrations, deploy with the secrets, again for the workers.dev URL", async () => {
  const s = setup();
  const r = await s.run();
  const name = r.name;
  expect(name).toMatch(/^my-app-/);
  expect(s.calls().map(cmd)).toEqual([
    `secret list --name ${name} --format json`,
    "d1 list --json",
    `d1 create ${name}-index`,
    "d1 list --json",
    `d1 migrations apply ${name}-index --remote --config`,
    "deploy --config --secrets-file",
    "deploy --config",
  ]);
  // The secrets file: 0600, gone once wrangler returned.
  const sent = s.calls().find((c) => c.secrets)!;
  expect(sent.secrets!.mode).toBe(0o600);
  expect(existsSync(sent.argv[sent.argv.indexOf("--secrets-file") + 1]!)).toBe(false);
  expect(r.url).toBe(`https://${name}.acct.workers.dev`);
  const w = s.account().workers[name]!;
  expect(w.vars).toEqual({ CONNECTD_PUBLIC_URL: r.url as string });
  expect(Object.keys(w.secrets).sort()).toEqual(
    ["GH_ID", "GH_SECRET", "CONNECTD_API_KEY", "CONNECTD_KEY_V1", "CONNECTD_SESSIONS_KEY", "CONNECTD_STATE_KEY", "CONNECTD_WEBHOOKS_KEY"].sort(),
  );
  expect(w.secrets.GH_SECRET).toBe("prod-secret");
  // Secrets never in argv; generated files and output hold none of them, except the API key printed once.
  const values = Object.values(w.secrets);
  for (const c of s.calls()) for (const v of values) expect(c.argv.join(" ")).not.toContain(v);
  const files = [r.generated.entry, r.generated.wrangler, join(s.dir, ".connectd", "deploy", "state.json")].map((f) => readFileSync(f, "utf8")).join("\n");
  const out = s.lines.join("\n");
  for (const [k, v] of Object.entries(w.secrets)) {
    expect(files).not.toContain(v);
    if (k === "CONNECTD_API_KEY") expect(out.split(v).length - 1).toBe(1);
    else expect(out).not.toContain(v);
  }
  expect(r.apiKey).toBe(w.secrets.CONNECTD_API_KEY!);
  expect(out).toContain(`${r.url}/dashboard`);

  const cfg = JSON.parse(readFileSync(r.generated.wrangler, "utf8"));
  expect(cfg).toMatchObject({
    name,
    main: "worker.ts",
    workers_dev: true,
    durable_objects: { bindings: [{ name: "CONNECTION", class_name: "Connection" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["Connection"] }],
    d1_databases: [{ binding: "INDEX", database_name: `${name}-index`, database_id: "db-0", migrations_dir: "migrations" }],
  });
  expect(existsSync(join(r.generated.migrations, "0001_index.sql"))).toBe(true);
});

test("re-deploy: no new keys, one deploy, same database; --rotate key adds V2; --rotate api-key prints a new one", async () => {
  const s = setup();
  const first = await s.run();
  const before = { ...s.account().workers[first.name]!.secrets };
  s.reset();
  const again = await s.run();
  expect(s.calls().map(cmd)).toEqual([
    `secret list --name ${first.name} --format json`,
    "d1 list --json",
    `d1 migrations apply ${first.name}-index --remote --config`,
    "deploy --config --secrets-file",
  ]);
  expect(again.pushed).toEqual(["GH_ID", "GH_SECRET"]);
  expect(again.apiKey).toBeUndefined();
  expect(s.account().workers[first.name]!.secrets).toEqual(before);
  expect(s.account().dbs.length).toBe(1);

  // An empty env file and nothing missing: no secrets sent at all.
  s.reset();
  writeFileSync(join(s.dir, ".empty"), "");
  await s.run({ envFile: ".empty" });
  expect(s.calls().some((c) => c.secrets)).toBe(false);

  const rot = await s.run({ rotate: ["key"] });
  expect(rot.pushed).toEqual(["GH_ID", "GH_SECRET", "CONNECTD_KEY_V2"]);
  expect(s.account().workers[first.name]!.secrets.CONNECTD_KEY_V1).toBe(before.CONNECTD_KEY_V1!);
  const rot2 = await s.run({ rotate: ["key", "state"] });
  expect(rot2.pushed).toEqual(["GH_ID", "GH_SECRET", "CONNECTD_KEY_V3", "CONNECTD_STATE_KEY"]);
  const api = await s.run({ rotate: ["api-key"] });
  expect(api.apiKey).toBeDefined();
  expect(api.apiKey).not.toBe(first.apiKey);
});

test("custom domain: --url sets the var and a custom-domain route, deployed once", async () => {
  const s = setup();
  const r = await s.run({ url: "https://connect.example.com" });
  expect(s.calls().filter((c) => c.argv[0] === "deploy").length).toBe(1);
  expect(r.url).toBe("https://connect.example.com");
  expect(JSON.parse(readFileSync(r.generated.wrangler, "utf8"))).toMatchObject({
    workers_dev: false,
    routes: [{ pattern: "connect.example.com", custom_domain: true }],
    vars: { CONNECTD_PUBLIC_URL: "https://connect.example.com" },
  });
  await expect(s.run({ url: "https://example.com/oc" })).rejects.toThrow(/served at its root/);
  await expect(s.run({ url: "http://example.com" })).rejects.toThrow(/https/);
});

test("refused before anything changes: dev keys, generated keys in the env file, bad rotations", async () => {
  const s = setup({ events: true });

  for (const [vars, err] of [
    ["CONNECTD_STATE_KEY=x\n", /generated by deploy/],
    ["CONNECTD_KEY_V1=x\n", /generated by deploy/],
    ["CONNECTD_PUBLIC_URL=https://x.test\n", /comes from --url/],
  ] as const) {
    writeFileSync(join(s.dir, ".prod.vars"), vars);
    await expect(s.run()).rejects.toThrow(err);
  }
  mkdirSync(join(s.dir, ".connectd"), { recursive: true });
  writeFileSync(join(s.dir, ".connectd", "dev.vars"), "CONNECTD_API_KEY=oc_dev\n");
  await expect(s.run({ envFile: ".connectd/dev.vars" })).rejects.toThrow(/dev keys/);
  writeFileSync(join(s.dir, ".prod.vars"), "CONNECTD_API_KEY=oc_dev\n");
  await expect(s.run()).rejects.toThrow(/is the dev value/);
  writeFileSync(join(s.dir, ".prod.vars"), "CONNECTD_API_KEY=mine\n");
  await expect(s.run({ rotate: ["api-key"] })).rejects.toThrow(/change it there/);
  await expect(s.run({ rotate: ["webhooks"] })).rejects.toThrow(/break every registered webhook/);
  await expect(s.run({ rotate: ["nope"] })).rejects.toThrow(/--rotate takes/);
  await expect(s.run({ envFile: "missing.vars" })).rejects.toThrow(/no env file/);

  // With the secret in the env file it goes through, and the given API key is used (never printed).
  writeFileSync(join(s.dir, ".prod.vars"), `CONNECTD_API_KEY=mine\nCONNECTD_EVENTS_SECRET=whsec_${btoa("x".repeat(32))}\n`);
  const r = await s.run();
  expect(r.apiKey).toBeUndefined();
  expect(s.account().workers[r.name]!.secrets.CONNECTD_API_KEY).toBe("mine");
  expect(s.lines.join("\n")).not.toContain("whsec_");
});

test("wrangler failures: missing binary explained, a failing step stops the deploy", async () => {
  const s = setup();
  await expect(s.run({ wrangler: join(TMP, "no-such-wrangler") })).rejects.toThrow(NO_WRANGLER);
  s.env.FAKE_FAIL = "d1 migrations";
  await expect(s.run()).rejects.toThrow(/wrangler d1 migrations apply failed \(1\):[\s\S]*boom/);
  expect(s.calls().some((c) => c.argv[0] === "deploy")).toBe(false);
  delete s.env.FAKE_FAIL;

  // A failing deploy that generated an API key says how to get a visible one.
  s.env.FAKE_FAIL = "deploy --config";
  await expect(s.run({ newKeys: true })).rejects.toThrow(/--rotate api-key/);
});

test("--dry-run: writes the entry, wrangler config and migrations, prints the plan, calls nothing", async () => {
  const s = setup();
  const r = await s.run({ dryRun: true, name: "My Worker!" });
  expect(r.name).toBe("my-worker");
  expect(s.calls()).toEqual([]);
  const out = s.lines.join("\n");
  expect(out).toContain("dry run: nothing is sent to Cloudflare");
  expect(out).toContain("definitions  keyed, gh");
  expect(out).toContain(".connectd/deploy/worker.ts");
  const entry = readFileSync(r.generated.entry, "utf8");
  expect(entry).toContain('from "../../oc.config.ts"');
  expect(entry).not.toContain("connectd:config");
  expect(entry).toMatch(/from "\.\.\/.*src\/runtime-cloudflare\.ts"/);
  expect(readFileSync(join(s.dir, ".connectd", ".gitignore"), "utf8")).toBe("*\n");
});

test("cli: deploy flags, --managed deferred", async () => {
  const out: string[] = [];
  const log = (l: string) => void out.push(l);
  expect(await main(["deploy", "--managed"], { log })).toBe(1);
  expect(out.at(-1)).toContain("#34");
  const s = setup();
  expect(await main(["deploy", "--dry-run", "--name", "cli-test", "--env-file", ".prod.vars"], { log, dir: s.dir })).toBe(0);
  expect(out.join("\n")).toContain("connectd deploy cli-test");
  expect(await main(["deploy", "--dry-run", "--url", "nope"], { log, dir: s.dir })).toBe(1);
  // generate() alone, as the workerd test uses it.
  expect(generate({ dir: s.dir, config: join(s.dir, "oc.config.ts"), name: "x" }).wrangler).toEndWith("wrangler.json");
});

test("existing Worker without state.json (CI): refused until --url, its vars never dropped", async () => {
  const s = setup();
  const first = await s.run();
  rmSync(join(s.dir, ".connectd", "deploy", "state.json"));
  s.reset();
  await expect(s.run()).rejects.toThrow(/exists, but its public URL isn't known here/);
  expect(s.calls().map(cmd)).toEqual([`secret list --name ${first.name} --format json`]);
  const again = await s.run({ url: first.url! });
  expect(again.pushed).toEqual(["GH_ID", "GH_SECRET"]);
  // Every version after the new Worker's first pass carried the public URL.
  expect(s.account().workers[first.name]!.history).toEqual([{}, { CONNECTD_PUBLIC_URL: first.url! }, { CONNECTD_PUBLIC_URL: first.url! }]);
});

test("new-Worker detection: only Cloudflare's 10007; an index without its Worker needs --new-keys", async () => {
  const s = setup();
  s.env.FAKE_FAIL = "secret list";
  s.env.FAKE_ERROR = "✘ [ERROR] A request to the Cloudflare API failed: route not found";
  await expect(s.run()).rejects.toThrow(/route not found/);
  expect(s.calls().length).toBe(1);
  delete s.env.FAKE_FAIL;

  // The database is there, the Worker isn't: fresh keys would orphan whatever was sealed before.
  const first = await s.run();
  const account = s.account();
  delete account.workers[first.name];
  writeFileSync(s.env.FAKE_ACCOUNT!, JSON.stringify(account));
  s.reset();
  await expect(s.run()).rejects.toThrow(/exists but Worker .* doesn't[\s\S]*--new-keys/);
  expect(s.calls().some((c) => c.argv[0] === "deploy")).toBe(false);
  const again = await s.run({ newKeys: true });
  expect(again.pushed).toContain("CONNECTD_KEY_V1");
});

test("generated entry: the runtime the project resolves", async () => {
  const s = setup();
  const r = await s.run({ dryRun: true });
  // The runtime through @kavishkagaya/connectd/runtime, as the project resolves it: in this repo, the CLI's re-export.
  expect(readFileSync(r.generated.entry, "utf8")).toMatch(/src\/runtime\.ts"/);
});

test("a signal during wrangler deploy removes the secrets file, stops wrangler, exits non-zero", async () => {
  const s = setup();
  const tmp = mkdtempSync(join(TMP, "tmpdir-"));
  const p = spawn(join(import.meta.dir, "bin.ts"), ["deploy", "--env-file", ".prod.vars"], {
    cwd: s.dir,
    env: { ...s.env, CONNECTD_WRANGLER: join(s.dir, "wrangler-fake"), FAKE_SLEEP: "1", TMPDIR: tmp },
    stdio: "ignore",
  });
  const secrets = () => readdirSync(tmp).flatMap((d) => (existsSync(join(tmp, d, "secrets.json")) ? [d] : []));
  for (let i = 0; !secrets().length; i++) {
    if (i > 250) throw new Error("no secrets file appeared");
    await Bun.sleep(20);
  }
  const code = new Promise((r) => p.on("exit", (c) => r(c)));
  p.kill("SIGTERM");
  expect(await code).toBe(143);
  expect(readdirSync(tmp)).toEqual([]);
});

test("one env: .env.production by default, only the names the project reads are sent (the list printed first); the shell otherwise; .env refused", async () => {
  const s = setup({ vars: "" });
  writeFileSync(join(s.dir, ".env.production"), "GH_ID=prod-id\nGH_SECRET=prod-secret\nDATABASE_URL=postgres://prod\n");
  const r = await s.run({ envFile: undefined });
  const w = s.account().workers[r.name]!;
  expect(w.secrets.GH_ID).toBe("prod-id");
  expect(Object.keys(w.secrets)).not.toContain("DATABASE_URL");
  const out = s.lines.join("\n");
  expect(out).toContain("secrets      GH_ID, GH_SECRET from .env.production");
  expect(out).toContain("not sent     DATABASE_URL");

  // Manual deploy: the app's env lines, the new API key once.
  expect(out).toContain(`CONNECTD_URL=${r.url}`);
  expect(out).toContain(`CONNECTD_API_KEY=${r.apiKey}   (shown once`);

  // No file outside CI: refused (a local shell holds dev's .env too).
  const t = setup({ vars: "" });
  await expect(t.run({ envFile: undefined })).rejects.toThrow("no .env.production");
  // CI: the shell's environment (CI secrets), still only the names read; the API key must come from it.
  const shell = { ...t.env, CI: "true", GH_ID: "shell-id", GH_SECRET: "shell-secret", DATABASE_URL: "postgres://prod" };
  await expect(t.run({ envFile: undefined, env: shell })).rejects.toThrow("CI: set CONNECTD_API_KEY");
  const r2 = await t.run({ envFile: undefined, env: { ...shell, CONNECTD_API_KEY: "oc_from_ci" } });
  const w2 = t.account().workers[r2.name]!;
  expect(w2.secrets.GH_ID).toBe("shell-id");
  expect(w2.secrets.CONNECTD_API_KEY).toBe("oc_from_ci");
  expect(r2.apiKey).toBeUndefined();
  expect(Object.keys(w2.secrets)).not.toContain("DATABASE_URL");
  expect(Object.keys(w2.secrets)).not.toContain("PATH");
  expect(Object.keys(w2.secrets)).not.toContain("CI");
  expect(t.lines.join("\n")).toContain("from the shell environment");
  expect(t.lines.join("\n")).not.toContain("oc_from_ci");

  // Dev's values never go out: .env as the file, or a value equal to .env's.
  writeFileSync(join(t.dir, ".env"), "GH_ID=dev-id\n");
  await expect(t.run({ envFile: ".env" })).rejects.toThrow(".env is dev's");
  await expect(t.run({ envFile: undefined, env: { ...shell, GH_ID: "dev-id", CONNECTD_API_KEY: "oc_from_ci" } })).rejects.toThrow("GH_ID in the shell environment is the dev value from .env");
});

test("parseEnv: a double-quoted value may span lines (a PEM key)", () => {
  expect(parseEnv('K="-----BEGIN KEY-----\nabc\n-----END KEY-----"\nB=plain # c\nE="say \\"hi\\""')).toEqual({ K: "-----BEGIN KEY-----\nabc\n-----END KEY-----", B: "plain", E: 'say "hi"' });
});

test("targets: deploy needs one; the options give the name and URL, flags win; deploy: {} is the old shape", async () => {
  await expect(setup({ target: "undefined" }).run()).rejects.toThrow("deploy needs a target in oc.config.ts");
  const s = setup({ target: 'cloudflare({ name: "from-config", url: "https://oc.example.com" })' });
  const r = await s.run({ dryRun: true });
  expect(r.name).toBe("from-config");
  expect(r.url).toBe("https://oc.example.com");
  expect((await s.run({ dryRun: true, name: "from-flag" })).name).toBe("from-flag");
  const bad = setup({ target: '{ adapter: "@kavishkagaya/connectd-nope/adapter", options: {} }' });
  await expect(bad.run()).rejects.toThrow("adapter @kavishkagaya/connectd-nope/adapter isn't installed: npm i -D @kavishkagaya/connectd-nope");
  await expect(setup({ target: '{ adapter: "nope-adapter/deploy" }' }).run()).rejects.toThrow("isn't installed: npm i -D nope-adapter");
  await expect(setup({ target: "cloudflare" }).run()).rejects.toThrow("did you forget the call?");
  const old = setup({ target: "cloudflare(), deploy: { name: 'x' }" });
  await expect(old.run()).rejects.toThrow("the config's deploy: { name, url } is gone");
});

test("--env: its own env file, Worker, database, state and keys; the events secret generated once per environment", async () => {
  const s = setup({ events: true });
  writeFileSync(join(s.dir, ".env.staging"), "GH_ID=staging-id\nGH_SECRET=staging-secret\n");
  const prod = await s.run();
  const staging = await s.run({ envFile: undefined, environment: "staging" });
  expect(staging.name).toBe(`${prod.name}-staging`);
  expect(s.account().dbs.map((d) => d.name).sort()).toEqual([`${prod.name}-index`, `${prod.name}-staging-index`].sort());
  const [p, st] = [s.account().workers[prod.name]!.secrets, s.account().workers[staging.name]!.secrets];
  expect(st.GH_ID).toBe("staging-id");
  expect(p.GH_ID).toBe("prod-id");
  // Each environment's keys are its own, and the app's two are printed once with the environment named.
  for (const k of ["CONNECTD_KEY_V1", "CONNECTD_STATE_KEY", "CONNECTD_API_KEY", "CONNECTD_EVENTS_SECRET"]) expect(st[k]).not.toBe(p[k]);
  expect(staging.eventsSecret).toBe(st.CONNECTD_EVENTS_SECRET!);
  expect(staging.eventsSecret).toStartWith("whsec_");
  expect(s.lines.join("\n")).toContain(`your app's env for staging`);
  expect(s.lines.join("\n")).toContain(`CONNECTD_EVENTS_SECRET=${staging.eventsSecret}   (shown once`);
  expect(existsSync(join(s.dir, ".connectd", "deploy", "state.staging.json"))).toBe(true);
  // Again: nothing regenerated; --rotate events makes a new one, shown once.
  const again = await s.run({ envFile: undefined, environment: "staging" });
  expect(again.name).toBe(staging.name);
  expect(again.eventsSecret).toBeUndefined();
  expect(again.apiKey).toBeUndefined();
  const rot = await s.run({ envFile: undefined, environment: "staging", rotate: ["events"] });
  expect(rot.eventsSecret).not.toBe(staging.eventsSecret);
  // A set secret is the env file's to change; dev's names and bad names are refused; no file, no deploy.
  writeFileSync(join(s.dir, ".env.staging"), `GH_ID=staging-id\nCONNECTD_EVENTS_SECRET=whsec_${btoa("s".repeat(32))}\n`);
  await expect(s.run({ envFile: undefined, environment: "staging", rotate: ["events"] })).rejects.toThrow(/change it there/);
  await expect(s.run({ envFile: undefined, environment: "development" })).rejects.toThrow(/is dev's/);
  await expect(s.run({ envFile: undefined, environment: "Staging!" })).rejects.toThrow(/lowercase/);
  await expect(s.run({ envFile: undefined, environment: "preview" })).rejects.toThrow(/no \.env\.preview/);
  // The target's options can name an environment's Worker and URL.
  writeFileSync(join(s.dir, ".env.preview"), "GH_ID=p\n");
  writeFileSync(join(s.dir, "oc.config.ts"), CONFIG(true, `cloudflare({ name: "app", environments: { preview: { name: "app-pr", url: "https://pr.example.com" } } })`));
  const pr = await s.run({ envFile: undefined, environment: "preview", dryRun: true });
  expect([pr.name, pr.url]).toEqual(["app-pr", "https://pr.example.com"]);
  expect((await s.run({ envFile: undefined, environment: "staging", dryRun: true })).name).toBe("app-staging");
  expect((await s.run({ dryRun: true })).name).toBe("app");
});
