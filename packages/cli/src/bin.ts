#!/usr/bin/env bun
import { main } from "./cli.ts";

// ponytail: Bun only (the config is TypeScript, bundled and hot-reloaded with Bun.build); a Node build of the CLI comes with publishing.
const r = await main(process.argv.slice(2));
if (typeof r === "number") process.exit(r);
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    void r().finally(() => process.exit(0));
  });
