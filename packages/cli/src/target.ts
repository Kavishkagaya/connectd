import type { Env, Resolved } from "./project.ts";

/**
 * Where `openconnect deploy` puts the project (SvelteKit-adapter style): `target: cloudflare({ name })`
 * in oc.config.ts. The config is bundled into the deployed runtime, so a target there is data only:
 * the module that deploys (`adapter`, resolved from the project at deploy time) and its options.
 * dev ignores it (memory driver, always local).
 */
export type Target = { adapter: string; options: Record<string, unknown> };

/** What the CLI hands an adapter: the project resolved against the production env, and the secrets to set. */
export type DeployContext = {
  dir: string;
  /** The module to bundle as the config (the generated entry with the connection folders, or the config itself). */
  entry: string;
  project: Resolved;
  /** The target's own options (`cloudflare({ name, url })`). */
  options: Record<string, unknown>;
  /** Flags, which win over the options. */
  name?: string;
  url?: string;
  /** The env names the project reads (and OPENCONNECT_EVENTS_SECRET / OPENCONNECT_API_KEY when set), with values: what becomes the deployment's secrets. */
  secrets: Record<string, string>;
  /** Where `secrets` came from (`.env.production`, the shell environment), for messages. */
  from: string;
  rotate: string[];
  dryRun: boolean;
  newKeys: boolean;
  /** CI: never generate or print an API key (it's in `secrets`). */
  ci: boolean;
  /** The plan lines every target prints (definitions, missing config, secrets by name). */
  summary: string[];
  /** The deploy tool's binary, when the caller names one (tests). */
  bin?: string;
  env: Env;
  log: (line: string) => void;
};

export type Deployed = { name: string; url?: string; dryRun: boolean; apiKey?: string; pushed?: string[]; [k: string]: unknown };

/** An adapter module's export. */
export type Adapter = { deploy(ctx: DeployContext): Promise<Deployed> };
