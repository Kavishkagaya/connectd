import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      main: "./test/worker.ts",
      miniflare: {
        compatibilityDate: "2026-09-01",
        durableObjects: { PROBE: { className: "Probe", useSQLite: true }, TOOLS: { className: "Tools", useSQLite: true } },
        d1Databases: ["DB"],
        // Applied by the tests (applyD1Migrations), after each reset. PARITY_VALUE: what platform parity reads from env.
        bindings: { MIGRATIONS: await readD1Migrations(`${import.meta.dirname}/migrations`), PARITY_VALUE: "parity" },
      },
    })),
  ],
  test: { include: ["test/**/*.test.ts"] },
});
