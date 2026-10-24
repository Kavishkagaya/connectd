/** `[command] [--flag value | --flag=value | --switch]... [-- anything]`. Flags are declared, so a typo is an error, not ignored. `after`: what follows `--`, untouched. */
export type Spec = Record<string, "string" | "boolean">;

export function parse(argv: string[], spec: Spec): { command: string | undefined; flags: Record<string, string | boolean>; rest: string[]; after: string[] } {
  const flags: Record<string, string | boolean> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--") return { command: rest.shift(), flags, rest, after: argv.slice(i + 1) };
    if (a === "-h") {
      flags.help = true;
      continue;
    }
    if (!a.startsWith("--")) {
      rest.push(a);
      continue;
    }
    const [name, inline] = a.slice(2).split(/=(.*)/s) as [string, string | undefined];
    const kind = Object.hasOwn(spec, name) ? spec[name] : undefined;
    if (!kind) throw new Error(`unknown flag --${name}`);
    if (kind === "boolean") {
      if (inline !== undefined) throw new Error(`--${name} takes no value`);
      flags[name] = true;
    } else {
      const v = inline ?? argv[++i];
      if (v === undefined || (inline === undefined && v.startsWith("--"))) throw new Error(`--${name} needs a value`);
      flags[name] = v;
    }
  }
  return { command: rest.shift(), flags, rest, after: [] };
}
