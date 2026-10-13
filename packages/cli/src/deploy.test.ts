import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "./cli.ts";
import { deploy, type DeployOptions, NO_WRANGLER } from "./deploy.ts";
import { generate } from "./generate.ts";
import { importConfig } from "./load.ts";

const TMP = join(import.meta.dir, "..", ".tmp-deploy");
mkdirSync(TMP, { recursive: true });
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

/**
 * A fake wrangler: records argv and stdin of every call, and keeps a fake account (D1 databases,
 * secrets by Worker) in a JSON file, enough to answer the commands deploy runs.
 */
const FAKE = `#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const [log, path] = [process.env.FAKE_LOG, process.env.FAKE_ACCOUNT];
const argv = process.argv.slice(2);
const stdin = argv[1] === "bulk" ? await Bun.stdin.text() : null;
appendFileSync(log, JSON.stringify({ argv, stdin }) + "\\n");
const a = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { dbs: [], workers: {} };
const save = () => writeFileSync(path, JSON.stringify(a));
const opt = (n) => argv[argv.indexOf(n) + 1];
console.error("▲ [WARNING] Proxy environment variables detected.");
if (process.env.FAKE_FAIL === argv.slice(0, 2).join(" ")) { console.error("boom"); process.exit(1); }
const [c1, c2] = argv;
if (c1 === "secret" && c2 === "list") {
  const w = a.workers[opt("--name")];
  if (!w) { console.error("This Worker does not exist on your account. [code: 10007]"); process.exit(1); }
  console.log(JSON.stringify(Object.keys(w.secrets).map((name) => ({ name, type: "secret_text" }))));
} else if (c1 === "secret" && c2 === "bulk") {
  Object.assign(a.workers[opt("--name")].secrets, JSON.parse(stdin)); save();
  console.log("Finished processing secrets file");
} else if (c1 === "d1" && c2 === "list") console.log(JSON.stringify(a.dbs));
else if (c1 === "d1" && c2 === "create") { a.dbs.push({ uuid: "db-" + a.dbs.length, name: argv[2] }); save(); console.log("Created"); }
else if (c1 === "d1" && c2 === "migrations") console.log("Migrations applied");
else if (c1 === "deploy") {
  const cfg = JSON.parse(readFileSync(opt("--config"), "utf8"));
  a.workers[cfg.name] ??= { secrets: {} }; a.workers[cfg.name].vars = cfg.vars; save();
  console.log("Uploaded " + cfg.name + "\\n  https://" + cfg.name + ".acct.workers.dev\\nCurrent Version ID: 1");
} else { console.error("fake wrangler: unknown command"); process.exit(1); }
`;

const CONFIG = (events = false) => `import { apiKey, defineConnection, oauth2 } from "@openconnect/connections";
export default (env) => ({
  definitions: [
    defineConnection({ id: "keyed", auth: apiKey(["key"]) }),
    defineConnection({ id: "gh", auth: oauth2({ authorizeUrl: "https://p.test/a", tokenUrl: "https://p.test/t" }) }),
  ],
  config: env.GH_ID ? { gh: { clientId: env.GH_ID, clientSecret: env.GH_SECRET } } : {},
  ${events ? `events: { url: "https://app.test/events" },` : ""}
});
`;

function setup(o: { events?: boolean; vars?: string } = {}) {
  const dir = mkdtempSync(join(TMP, "my app-"));
  writeFileSync(join(dir, "openconnect.config.ts"), CONFIG(o.events));
  writeFileSync(join(dir, ".prod.vars"), o.vars ?? "GH_ID=prod-id\nGH_SECRET=prod-secret\n");
  const bin = join(dir, "wrangler-fake");
  writeFileSync(bin, FAKE);
  chmodSync(bin, 0o755);
  const env = { ...process.env, FAKE_LOG: join(dir, "calls.jsonl"), FAKE_ACCOUNT: join(dir, "account.json") } as Record<string, string>;
  const lines: string[] = [];
  let n = 0;
  const run = (x: Partial<DeployOptions> = {}) =>
    deploy({
      dir,
      config: join(dir, "openconnect.config.ts"),
      load: () => importConfig(join(dir, "openconnect.config.ts"), join(dir, ".openconnect", "build"), ++n),
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
          .map((l) => JSON.parse(l) as { argv: string[]; stdin: string | null })
      : [];
  const account = () => JSON.parse(readFileSync(env.FAKE_ACCOUNT!, "utf8")) as { dbs: { name: string }[]; workers: Record<string, { secrets: Record<string, string>; vars: Record<string, string> }> };
  return { dir, run, calls, account, lines, env, reset: () => rmSync(env.FAKE_LOG!, { force: true }) };
}

const cmd = (c: { argv: string[] }) => c.argv.filter((a) => !a.includes("/")).join(" ");

test("first deploy: D1 created, migrations, deploy twice for the workers.dev URL, every key generated over stdin", async () => {
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
    "deploy --config",
    "deploy --config",
    `secret bulk --name ${name}`,
  ]);
  expect(r.url).toBe(`https://${name}.acct.workers.dev`);
  const w = s.account().workers[name]!;
  expect(w.vars).toEqual({ OPENCONNECT_PUBLIC_URL: r.url as string });
  expect(Object.keys(w.secrets).sort()).toEqual(
    ["GH_ID", "GH_SECRET", "OPENCONNECT_API_KEY", "OPENCONNECT_KEY_V1", "OPENCONNECT_SESSIONS_KEY", "OPENCONNECT_STATE_KEY", "OPENCONNECT_WEBHOOKS_KEY"].sort(),
  );
  expect(w.secrets.GH_SECRET).toBe("prod-secret");
  // Secrets only ever on stdin; generated files and output hold none of them, except the API key printed once.
  const values = Object.values(w.secrets);
  for (const c of s.calls()) for (const v of values) expect(c.argv.join(" ")).not.toContain(v);
  const files = [r.generated.entry, r.generated.wrangler, join(s.dir, ".openconnect", "deploy", "state.json")].map((f) => readFileSync(f, "utf8")).join("\n");
  const out = s.lines.join("\n");
  for (const [k, v] of Object.entries(w.secrets)) {
    expect(files).not.toContain(v);
    if (k === "OPENCONNECT_API_KEY") expect(out.split(v).length - 1).toBe(1);
    else expect(out).not.toContain(v);
  }
  expect(r.apiKey).toBe(w.secrets.OPENCONNECT_API_KEY!);

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
    "deploy --config",
    `secret bulk --name ${first.name}`,
  ]);
  expect(again.pushed).toEqual(["GH_ID", "GH_SECRET"]);
  expect(again.apiKey).toBeUndefined();
  expect(s.account().workers[first.name]!.secrets).toEqual(before);
  expect(s.account().dbs.length).toBe(1);

  // No env file and nothing missing: no secret bulk at all.
  s.reset();
  await s.run({ envFile: undefined });
  expect(s.calls().some((c) => c.argv[1] === "bulk")).toBe(false);

  const rot = await s.run({ rotate: ["key"] });
  expect(rot.pushed).toEqual(["GH_ID", "GH_SECRET", "OPENCONNECT_KEY_V2"]);
  expect(s.account().workers[first.name]!.secrets.OPENCONNECT_KEY_V1).toBe(before.OPENCONNECT_KEY_V1!);
  const rot2 = await s.run({ rotate: ["key", "state"] });
  expect(rot2.pushed).toEqual(["GH_ID", "GH_SECRET", "OPENCONNECT_KEY_V3", "OPENCONNECT_STATE_KEY"]);
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
    vars: { OPENCONNECT_PUBLIC_URL: "https://connect.example.com" },
  });
  await expect(s.run({ url: "https://example.com/oc" })).rejects.toThrow(/served at its root/);
  await expect(s.run({ url: "http://example.com" })).rejects.toThrow(/https/);
});

test("refused before anything changes: dev keys, generated keys in the env file, events without a secret, bad rotations", async () => {
  const s = setup({ events: true });
  await expect(s.run()).rejects.toThrow(/events are on: set OPENCONNECT_EVENTS_SECRET/);
  expect(s.calls().map(cmd)).toEqual([expect.stringMatching(/^secret list/)]);

  for (const [vars, err] of [
    ["OPENCONNECT_STATE_KEY=x\n", /generated by deploy/],
    ["OPENCONNECT_KEY_V1=x\n", /generated by deploy/],
    ["OPENCONNECT_PUBLIC_URL=https://x.test\n", /comes from --url/],
  ] as const) {
    writeFileSync(join(s.dir, ".prod.vars"), vars);
    await expect(s.run()).rejects.toThrow(err);
  }
  mkdirSync(join(s.dir, ".openconnect"), { recursive: true });
  writeFileSync(join(s.dir, ".openconnect", "dev.vars"), "OPENCONNECT_API_KEY=oc_dev\n");
  await expect(s.run({ envFile: ".openconnect/dev.vars" })).rejects.toThrow(/dev keys/);
  writeFileSync(join(s.dir, ".prod.vars"), "OPENCONNECT_API_KEY=oc_dev\n");
  await expect(s.run()).rejects.toThrow(/is the dev value/);
  writeFileSync(join(s.dir, ".prod.vars"), "OPENCONNECT_API_KEY=mine\n");
  await expect(s.run({ rotate: ["api-key"] })).rejects.toThrow(/change it there/);
  await expect(s.run({ rotate: ["webhooks"] })).rejects.toThrow(/break every registered webhook/);
  await expect(s.run({ rotate: ["nope"] })).rejects.toThrow(/--rotate takes/);
  await expect(s.run({ envFile: "missing.vars" })).rejects.toThrow(/no env file/);

  // With the secret in the env file it goes through, and the given API key is used (never printed).
  writeFileSync(join(s.dir, ".prod.vars"), `OPENCONNECT_API_KEY=mine\nOPENCONNECT_EVENTS_SECRET=whsec_${btoa("x".repeat(32))}\n`);
  const r = await s.run();
  expect(r.apiKey).toBeUndefined();
  expect(s.account().workers[r.name]!.secrets.OPENCONNECT_API_KEY).toBe("mine");
  expect(s.lines.join("\n")).not.toContain("whsec_");
});

test("wrangler failures: missing binary explained, a failing step stops the deploy", async () => {
  const s = setup();
  await expect(s.run({ wrangler: join(TMP, "no-such-wrangler") })).rejects.toThrow(NO_WRANGLER);
  s.env.FAKE_FAIL = "d1 migrations";
  await expect(s.run()).rejects.toThrow(/wrangler d1 migrations apply failed \(1\):[\s\S]*boom/);
  expect(s.calls().some((c) => c.argv[0] === "deploy" || c.argv[1] === "bulk")).toBe(false);
});

test("--dry-run: writes the entry, wrangler config and migrations, prints the plan, calls nothing", async () => {
  const s = setup();
  const r = await s.run({ dryRun: true, name: "My Worker!" });
  expect(r.name).toBe("my-worker");
  expect(s.calls()).toEqual([]);
  const out = s.lines.join("\n");
  expect(out).toContain("dry run: nothing is sent to Cloudflare");
  expect(out).toContain("definitions  keyed, gh");
  expect(out).toContain(".openconnect/deploy/worker.ts");
  const entry = readFileSync(r.generated.entry, "utf8");
  expect(entry).toContain('from "../../openconnect.config.ts"');
  expect(entry).not.toContain("openconnect:config");
  expect(entry).toMatch(/from "\.\.\/.*runtime\/src\/cloudflare\.ts"/);
  expect(readFileSync(join(s.dir, ".openconnect", ".gitignore"), "utf8")).toBe("*\n");
});

test("cli: deploy flags, --managed deferred", async () => {
  const out: string[] = [];
  const log = (l: string) => void out.push(l);
  expect(await main(["deploy", "--managed"], { log })).toBe(1);
  expect(out.at(-1)).toContain("#34");
  const s = setup();
  expect(await main(["deploy", "--dry-run", "--name", "cli-test", "--env-file", ".prod.vars"], { log, dir: s.dir })).toBe(0);
  expect(out.join("\n")).toContain("openconnect deploy cli-test");
  expect(await main(["deploy", "--dry-run", "--url", "nope"], { log, dir: s.dir })).toBe(1);
  // generate() alone, as the workerd test uses it.
  expect(generate({ dir: s.dir, config: join(s.dir, "openconnect.config.ts"), name: "x" }).wrangler).toEndWith("wrangler.json");
});
