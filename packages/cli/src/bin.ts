#!/usr/bin/env bun
import { main } from "./cli.ts";

// Bun runs the sources here, in the workspace; the published package's bin is this file built to JavaScript for Node (`bun run pack`).
const r = await main(process.argv.slice(2));
if (typeof r === "number") process.exit(r);
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    void r().finally(() => process.exit(0));
  });
