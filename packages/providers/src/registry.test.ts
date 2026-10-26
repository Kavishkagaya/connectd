import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { entries, files, REGISTRY } from "./registry.ts";

test("registry/ is built from the current sources (run `bun run registry` in packages/providers)", () => {
  for (const [name, body] of Object.entries(files())) expect(readFileSync(join(REGISTRY, name), "utf8")).toBe(body);
});

test("registry entries: env names from each provider's own config, a default export, only @kavishkagaya/connectd/connections imported", () => {
  const github = entries().find((e) => e.id === "github")!;
  expect(github.env).toEqual(["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"]);
  expect(entries().find((e) => e.id === "slack")!.optionalEnv).toEqual(["SLACK_SIGNING_SECRET"]);
  for (const e of entries()) {
    const src = e.files["connection.ts"]!;
    expect(src).toMatch(/\nexport default \w+;\n$/);
    expect([...src.matchAll(/from "([^"]+)"/g)].map((m) => m[1])).toEqual(["@kavishkagaya/connectd/connections"]);
  }
});
