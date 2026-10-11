import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./test/worker.ts",
      miniflare: {
        compatibilityDate: "2026-09-01",
        durableObjects: { PROBE: { className: "Probe", useSQLite: true } },
      },
    }),
  ],
  test: { include: ["test/**/*.test.ts"] },
});
