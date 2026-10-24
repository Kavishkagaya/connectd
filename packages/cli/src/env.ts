import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "./project.ts";
import { workdir } from "./workdir.ts";

export { workdir };

/**
 * `KEY=value` lines (dotenv syntax): `#` comments, optional `export`, single or double quotes; a
 * double-quoted value may span lines (a PEM private key), as Bun's and dotenv's loaders read it.
 */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(lines[i] as string);
    if (!m) continue;
    let v = m[2] ?? "";
    // An open double quote: the value goes on to the line that closes it.
    if (v.startsWith('"') && !/^"(?:[^"\\]|\\.)*"/.test(v)) {
      let j = i + 1;
      while (j < lines.length && !/(?:^|[^\\])"\s*$/.test(lines[j] as string)) j++;
      if (j < lines.length) {
        v = [v, ...lines.slice(i + 1, j + 1)].join("\n").trimEnd();
        i = j;
      }
    }
    const q = v[0];
    if (q === '"' && /^"(?:[^"\\]|\\.)*"/s.test(v)) {
      v = (/^"((?:[^"\\]|\\.)*)"/s.exec(v)?.[1] ?? "").replace(/\\n/g, "\n").replace(/\\(["\\])/g, "$1");
    } else if (q === "'" && v.endsWith(q) && v.length > 1) {
      v = v.slice(1, -1);
    } else v = v.replace(/\s+#.*$/, "");
    out[m[1] as string] = v;
  }
  return out;
}

const read = (path: string) => (existsSync(path) ? parseEnv(readFileSync(path, "utf8")) : {});

/**
 * Dev's environment, lowest to highest: `.env` (the app's one file, trigger.dev style: shared with
 * the app; `connectd init` wrote the keys into it), the process environment. The runtime gets only the names the project
 * reads (`workerEnv`), so the app's other vars (DATABASE_URL) never reach it.
 */
export function loadEnv(dir: string, processEnv: Env = process.env): Env {
  if (existsSync(join(dir, ".dev.vars"))) throw new Error(".dev.vars isn't read any more: move its lines into .env (one file for the app and connectd)");
  return { ...read(join(dir, ".env")), ...processEnv };
}
