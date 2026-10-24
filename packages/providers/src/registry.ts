import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AnyConnection, definitionOf, envConfig } from "@connectd/connections";
import { github, githubApp, google, slack } from "./index.ts";

/**
 * The provider catalog `connectd add` copies from (#54, shadcn style): `registry/<name>.json` at the
 * repo root, one per provider, plus `index.json`. Generated from `src/<file>.ts` by `bun run
 * registry`, committed; a test fails when it's stale. The CLI fetches it at its own version's tag.
 */

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

/** Each provider: its source file, its export, one line for the catalog. */
const CATALOG: { file: string; name: string; c: AnyConnection; description: string }[] = [
  { file: "github", name: "github", c: github, description: "GitHub OAuth app: user tokens, the REST API, repo webhook subscriptions" },
  { file: "github-app", name: "githubApp", c: githubApp, description: "GitHub App: one installation per connection, minted installation tokens, app webhooks" },
  { file: "google", name: "google", c: google, description: "Google OAuth (OIDC): Calendar and the Google APIs, calendar watch channels" },
  { file: "slack", name: "slack", c: slack, description: "Slack OAuth v2: bot and user tokens, Events API webhooks" },
];

export type Entry = {
  /** The connection's id, and the folder it's copied to. */
  id: string;
  version: string;
  description: string;
  /** Env names it needs (`env("NAME")`), and ones it reads if set (`env.optional`). */
  env: string[];
  optionalEnv: string[];
  /** The files of its folder, by name: `connection.ts`. */
  files: Record<string, string>;
};

export function entries(): Entry[] {
  return CATALOG.map(({ file, name, c, description }) => {
    const def = definitionOf(c);
    const r: { read: string[]; missing: string[] } = def.configFrom ? envConfig(def.configFrom, {}) : { read: [], missing: [] };
    const source = readFileSync(new URL(`./${file}.ts`, import.meta.url), "utf8");
    // The folder's connection is its default export; the named export stays for the file's own types.
    return {
      id: c.id,
      version: pkg.version,
      description,
      env: r.missing,
      optionalEnv: r.read.filter((n) => !r.missing.includes(n)),
      files: { "connection.ts": `${source.trimEnd()}\n\nexport default ${name};\n` },
    };
  });
}

export const files = (): Record<string, string> => {
  const list = entries();
  const out: Record<string, string> = {
    "index.json": `${JSON.stringify(
      list.map(({ id, version, description }) => ({ id, version, description })),
      null,
      2,
    )}\n`,
  };
  for (const e of list) out[`${e.id}.json`] = `${JSON.stringify(e, null, 2)}\n`;
  return out;
};

export const REGISTRY = join(import.meta.dir, "..", "..", "..", "registry");

if (import.meta.main) {
  mkdirSync(REGISTRY, { recursive: true });
  for (const [name, body] of Object.entries(files())) writeFileSync(join(REGISTRY, name), body);
  console.log(`wrote registry/ (${entries().map((e) => e.id).join(", ")})`);
}
