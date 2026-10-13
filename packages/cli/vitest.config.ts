import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { generate } from "./src/generate.ts";
import { generateKeys } from "./src/keys.ts";

// What `openconnect deploy` would upload for test/fixture, run in workerd from its own wrangler.json:
// the generated entry, the DO class and migration, the D1 binding and the copied migrations.
const fixture = `${import.meta.dirname}/test/fixture`;
const g = generate({ dir: fixture, config: `${fixture}/openconnect.config.ts`, name: "fixture", url: "https://oc.test" });

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: g.wrangler },
      miniflare: {
        // The secrets `deploy` pushes, plus a provider secret from an env file.
        bindings: { ...generateKeys(), OPENCONNECT_API_KEY: "test-key", EXAMPLE_CLIENT_ID: "cid", MIGRATIONS: await readD1Migrations(g.migrations) },
        // The proxy's upstream.
        outboundService: (req: Request) => Response.json({ url: req.url }),
      },
    })),
  ],
  // The generated entry has the template's shape (test/generated.d.ts types it as src/worker.ts).
  resolve: { alias: { "openconnect:generated": g.entry } },
  test: { include: ["test/**/*.test.ts"] },
});
