import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The project's local directory: generated keys, the state snapshot, builds. Ignored by git on its own. */
export function workdir(dir: string) {
  const w = join(dir, ".connectd");
  mkdirSync(w, { recursive: true });
  if (!existsSync(join(w, ".gitignore"))) writeFileSync(join(w, ".gitignore"), "*\n");
  return w;
}
