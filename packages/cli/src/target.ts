import type { Env, Resolved } from "./project.ts";

/**
 * Where `connectd deploy` puts the project (SvelteKit-adapter style): `target: cloudflare({ name })`
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
  /** `--env` (default `production`): the target keeps each environment's deployment apart. */
  environment: string;
  /** Flags, which win over the options. */
  name?: string;
  url?: string;
  /** The env names the project reads, with values: the project's secrets (the deployment's keys come from `keys`). */
  secrets: Record<string, string>;
  /**
   * The deployment's own keys (#86), derived from the root key for this environment, with encryption
   * key versions 1..`versions`: the same values on every call, so a deploy sends them all every time.
   */
  keys(versions: number): Promise<Record<string, string>>;
  /** Where `secrets` came from (`.env.production`, the shell environment), for messages. */
  from: string;
  /** `key`: one more encryption key version. */
  rotate: string[];
  dryRun: boolean;
  /** The plan lines every target prints (definitions, missing config, secrets by name). */
  summary: string[];
  /** The deploy tool's binary, when the caller names one (tests). */
  bin?: string;
  env: Env;
  log: (line: string) => void;
};

/** `keys`: the app's credentials a first deploy made (shown once). */
export type Deployed = { name: string; url?: string; dryRun: boolean; pushed?: string[]; keys?: { key: string; info: { kind: string; name: string; id: string } }[]; [k: string]: unknown };

/** An adapter module's export. */
export type Adapter = { deploy(ctx: DeployContext): Promise<Deployed> };
