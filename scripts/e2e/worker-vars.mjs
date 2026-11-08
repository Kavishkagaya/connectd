// The Worker's secrets as `connectd deploy` sets them, for `wrangler dev` (`.dev.vars` next to the
// generated wrangler.json): the env file's values, the keys derived from the root key for
// `production`, and the public URL. Run in the project: `node worker-vars.mjs <public url>`.
import { readFileSync, writeFileSync } from "node:fs";
import { deploymentKeys } from "@kavishkagaya/connectd/keys";

const root = /^CONNECTD_ROOT_KEY=(.*)$/m.exec(readFileSync(".env", "utf8"))?.[1];
if (!root) throw new Error("no CONNECTD_ROOT_KEY in .env");
const keys = await deploymentKeys(root, "production");
const lines = [readFileSync(".env.production", "utf8").trim(), ...Object.entries(keys).map(([k, v]) => `${k}=${v}`), `CONNECTD_PUBLIC_URL=${process.argv[2]}`];
writeFileSync(".connectd/deploy/.dev.vars", `${lines.join("\n")}\n`, { mode: 0o600 });
