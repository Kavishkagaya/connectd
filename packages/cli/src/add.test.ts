import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { add, custom, diff, list, registryOf, unified } from "./add.ts";
import { TEMPLATES } from "./templates.ts";
import { main } from "./cli.ts";
import { loadProject } from "./load.ts";
import { resolve } from "./project.ts";

const TMP = join(import.meta.dir, "..", ".tmp-add");
mkdirSync(TMP, { recursive: true });
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
/** The repo's own catalog, as the CLI fetches it at its tag. */
const REGISTRY = join(import.meta.dir, "..", "..", "..", "registry");

function project(env?: string) {
  const dir = mkdtempSync(join(TMP, "p-"));
  writeFileSync(join(dir, "oc.config.ts"), `import { defineConfig } from "@kavishkagaya/connectd";\nexport default defineConfig({ dir: "src/oc" });\n`);
  mkdirSync(join(dir, "src/oc"), { recursive: true });
  if (env !== undefined) writeFileSync(join(dir, ".env"), env);
  const lines: string[] = [];
  return { dir, lines, o: { dir, registry: REGISTRY, env: {}, log: (l: string) => void lines.push(l) } };
}

test("add: the provider as source in its folder, an empty events.ts, its env names in .env; the project runs it", async () => {
  const p = project("APP_ORIGIN=http://localhost:3000");
  await add({ ...p.o, provider: "github" });
  const src = readFileSync(join(p.dir, "src/oc/github/connection.ts"), "utf8");
  expect(src.split("\n")[0]).toBe("// connectd: github@0.0.0. Copied by `connectd add`; yours to edit. `connectd diff github` shows what changed upstream.");
  expect(src).toContain('from "@kavishkagaya/connectd/connections";');
  expect(src).not.toContain("@kavishkagaya/connectd-kernel");
  expect(readFileSync(join(p.dir, "src/oc/github/events.ts"), "utf8")).toContain('export default listen("github");');
  expect(readFileSync(join(p.dir, ".env"), "utf8")).toBe("APP_ORIGIN=http://localhost:3000\n\n# github (connectd add github)\nGITHUB_CLIENT_ID=\nGITHUB_CLIENT_SECRET=\n");
  expect(p.lines[0]).toContain("added github@0.0.0 as github: src/oc/github/connection.ts, src/oc/github/events.ts, .env");

  // It's a connection folder like any other: discovered, bundled, its env read.
  const r = await loadProject(p.dir, join(p.dir, "oc.config.ts"), join(p.dir, ".connectd", "build"), 1, {});
  expect(r.found.map((f) => [f.id, !!f.events])).toEqual([["github", true]]);
  expect(resolve(r.config, { GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "s" }).config?.github).toMatchObject({ clientId: "id" });

  // Again: refused (yours now); under another id; optional names stay commented, once.
  await expect(add({ ...p.o, provider: "github" })).rejects.toThrow("src/oc/github/connection.ts exists: `connectd diff github`");
  await add({ ...p.o, provider: "github", id: "gh" });
  expect(existsSync(join(p.dir, "src/oc/gh/connection.ts"))).toBe(true);
  await add({ ...p.o, provider: "slack" });
  await add({ ...p.o, provider: "slack", id: "slack2" });
  const env = readFileSync(join(p.dir, ".env"), "utf8");
  expect(env.match(/SLACK_SIGNING_SECRET/g)?.length).toBe(1);
  expect(env).toContain("# optional:\n# SLACK_SIGNING_SECRET=\n");
  expect(env.match(/GITHUB_CLIENT_ID/g)?.length).toBe(1);
  await expect(add({ ...p.o, provider: "nope" })).rejects.toThrow("nope isn't in the catalog");
});

test("add: .env edge cases; a malformed catalog entry is refused before anything is written", async () => {
  // No trailing newline, CRLF, an optional name listed indented, a required one only commented out.
  const p = project("A=1\r\n  # SLACK_SIGNING_SECRET=\r\n# SLACK_CLIENT_ID=old");
  await add({ ...p.o, provider: "slack" });
  const env = readFileSync(join(p.dir, ".env"), "utf8");
  expect(env.match(/SLACK_SIGNING_SECRET/g)?.length).toBe(1);
  expect(env).toContain("\nSLACK_CLIENT_ID=\n");
  // Uncommented with a value, the optional line reads as just that value.
  const { parseEnv } = await import("./env.ts");
  expect(parseEnv("# optional:\nSLACK_SIGNING_SECRET=abc\n").SLACK_SIGNING_SECRET).toBe("abc");

  const bad = project();
  const reg = mkdtempSync(join(TMP, "reg-"));
  writeFileSync(join(reg, "evil.json"), JSON.stringify({ id: "evil", version: "1", env: ["X=\nCONNECTD_API_KEY=attacker"], optionalEnv: [], files: { "connection.ts": "" } }));
  writeFileSync(join(reg, "empty.json"), JSON.stringify({ id: "empty", version: "1", env: [], optionalEnv: [], files: {} }));
  writeFileSync(join(reg, "junk.json"), "<html>");
  await expect(add({ ...bad.o, registry: reg, provider: "evil" })).rejects.toThrow("evil.json: not a catalog entry");
  await expect(add({ ...bad.o, registry: reg, provider: "empty" })).rejects.toThrow("empty.json: not a catalog entry");
  await expect(add({ ...bad.o, registry: reg, provider: "junk" })).rejects.toThrow("junk.json isn't JSON");
  expect(existsSync(join(bad.dir, "src/oc/evil"))).toBe(false);
  expect(existsSync(join(bad.dir, ".env"))).toBe(false);
});

test("diff: yours against the catalog's, hunks with context; unchanged says so", async () => {
  const p = project();
  await add({ ...p.o, provider: "google" });
  expect(await diff({ ...p.o, id: "google" })).toBe(false);
  expect(p.lines.at(-1)).toBe("google matches google@0.0.0");
  const file = join(p.dir, "src/oc/google/connection.ts");
  writeFileSync(file, readFileSync(file, "utf8").replace('connection("google")', 'connection("google") // mine'));
  expect(await diff({ ...p.o, id: "google" })).toBe(true);
  const out = p.lines.at(-1)!;
  expect(out).toContain("--- src/oc/google/connection.ts (yours, from google@0.0.0)");
  expect(out).toContain('-export const google = connection("google") // mine');
  expect(out).toContain('+export const google = connection("google")');
  // A CRLF checkout of an unchanged copy still matches.
  writeFileSync(file, readFileSync(file, "utf8").replace(" // mine", "").replace(/\n/g, "\r\n"));
  expect(await diff({ ...p.o, id: "google" })).toBe(false);
  writeFileSync(join(p.dir, "src/oc/google/connection.ts"), "export default 1;\n");
  await expect(diff({ ...p.o, id: "google" })).rejects.toThrow("wasn't copied by `connectd add`");
});

test("catalog: listed from index.json; fetched over HTTP at this version's tag (main while unreleased)", async () => {
  const p = project();
  await list(p.o);
  expect(p.lines[0]).toContain("github-app");
  const { version } = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as { version: string };
  const ref = version === "0.0.0" ? "main" : `v${version}`;
  expect(registryOf({})).toBe(`https://raw.githubusercontent.com/Kavishkagaya/connectd/${ref}/registry`);
  expect(registryOf({ env: { CONNECTD_REGISTRY: "https://r.test/x" } })).toBe("https://r.test/x");
  const asked: string[] = [];
  const fetch = (async (url: string) => {
    asked.push(url);
    const f = join(REGISTRY, url.replace("https://r.test/reg/", ""));
    return existsSync(f) ? new Response(readFileSync(f)) : new Response("no", { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  await add({ ...p.o, registry: "https://r.test/reg/", fetch, provider: "slack" });
  expect(asked).toEqual(["https://r.test/reg/slack.json"]);
  await expect(add({ ...p.o, registry: "https://r.test/reg", fetch, provider: "nope" })).rejects.toThrow("nope isn't in the catalog (https://r.test/reg/nope.json)");
});

test("cli: add and diff", async () => {
  const p = project();
  const lines: string[] = [];
  const run = (...argv: string[]) => main([...argv, "--registry", REGISTRY], { dir: p.dir, log: (l) => void lines.push(l) });
  expect(await run("add")).toBe(0);
  expect(await run("add", "github", "--id", "gh")).toBe(0);
  expect(await run("diff", "gh")).toBe(0);
  expect(lines.at(-1)).toBe("gh matches github@0.0.0");
  writeFileSync(join(p.dir, "src/oc/gh/connection.ts"), `${readFileSync(join(p.dir, "src/oc/gh/connection.ts"), "utf8")}// mine\n`);
  expect(await run("diff", "gh")).toBe(1);
  expect(await run("diff")).toBe(2);
  expect(await run("add", "a", "b")).toBe(2);
  expect(await run("add", "github", "--id", "gh")).toBe(1);
});

test("add --custom: every template is a connection folder the project runs; its env names in .env; no upstream to diff", async () => {
  const p = project();
  for (const t of TEMPLATES) await custom({ ...p.o, id: `my-${t}`, template: t });
  const src = readFileSync(join(p.dir, "src/oc/my-oauth2/connection.ts"), "utf8");
  expect(src.split("\n")[0]).toBe("// connectd: custom (oauth2 template). Written by `connectd add --custom`; yours to edit.");
  expect(src).toContain('env("MY_OAUTH2_CLIENT_ID")');
  expect(readFileSync(join(p.dir, "src/oc/my-oauth2/events.ts"), "utf8")).toContain('export default listen("my-oauth2");');
  const env = readFileSync(join(p.dir, ".env"), "utf8");
  expect(env).toContain("# my-oauth2 (connectd add --custom my-oauth2)\nMY_OAUTH2_CLIENT_ID=\nMY_OAUTH2_CLIENT_SECRET=\n");
  expect(env).toContain("MY_JWT_BEARER_PRIVATE_KEY=");
  expect(env).not.toContain("MY_API_KEY");

  const r = await loadProject(p.dir, join(p.dir, "oc.config.ts"), join(p.dir, ".connectd", "build"), 1, {});
  expect(r.found.map((f) => f.id).sort()).toEqual(TEMPLATES.map((t) => `my-${t}`).sort());
  const res = resolve(r.config, {});
  expect(res.missing["my-device"]).toEqual(["MY_DEVICE_CLIENT_ID", "MY_DEVICE_CLIENT_SECRET"]);
  expect(res.missing["my-api-key"]).toBeUndefined();

  await expect(custom({ ...p.o, id: "my-oauth2" })).rejects.toThrow("src/oc/my-oauth2/connection.ts exists: --force overwrites it");
  await custom({ ...p.o, id: "my-oauth2", template: "api-key", force: true });
  expect(readFileSync(join(p.dir, "src/oc/my-oauth2/connection.ts"), "utf8")).toContain("f.apiKey(");
  await expect(diff({ ...p.o, id: "my-oauth2" })).rejects.toThrow("is a custom connection");
  await expect(custom({ ...p.o, id: "x", template: "saml" })).rejects.toThrow("no template saml: oauth2, oidc, api-key");
  await expect(custom({ ...p.o, id: "a/b" })).rejects.toThrow("--custom: letters, digits");
});

test("cli: add --custom", async () => {
  const p = project();
  const lines: string[] = [];
  const run = (...argv: string[]) => main(argv, { dir: p.dir, log: (l) => void lines.push(l) });
  expect(await run("add", "--custom", "crm", "--template", "client-credentials")).toBe(0);
  expect(lines.at(-1)).toContain("added crm from the client-credentials template");
  expect(readFileSync(join(p.dir, "src/oc/crm/connection.ts"), "utf8")).toContain("f.clientCredentials(");
  expect(await run("add", "--custom", "crm2")).toBe(0);
  expect(readFileSync(join(p.dir, "src/oc/crm2/connection.ts"), "utf8")).toContain(".oauth2({");
  expect(await run("add", "github", "--custom", "crm3")).toBe(2);
  expect(await run("add", "github", "--template", "oidc")).toBe(2);
  expect(await run("add", "--custom", "crm", "--template", "nope")).toBe(1);
});

test("unified: hunks, context, merged nearby changes", () => {
  expect(unified(["a", "b", "c"], ["a", "x", "c"])).toEqual(["@@ -1,3 +1,3 @@", " a", "-b", "+x", " c"]);
  const a = Array.from({ length: 20 }, (_, i) => `l${i}`);
  const b = a.map((l, i) => (i === 2 || i === 17 ? `${l}!` : l));
  const h = unified(a, b);
  expect(h.filter((l) => l.startsWith("@@"))).toEqual(["@@ -1,6 +1,6 @@", "@@ -15,6 +15,6 @@"]);
  expect(unified(["a"], ["a"])).toEqual([]);
});
