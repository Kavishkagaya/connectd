import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      main: "./test/worker.ts",
      miniflare: {
        compatibilityDate: "2026-09-01",
        durableObjects: { CONNECTION: { className: "Connection", useSQLite: true } },
        d1Databases: ["INDEX"],
        // Applied by the tests (applyD1Migrations), after each reset.
        bindings: { MIGRATIONS: await readD1Migrations(`${import.meta.dirname}/migrations`) },
      },
    })),
  ],
  test: { include: ["test/**/*.test.ts"] },
});
