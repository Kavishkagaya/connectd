import type { Env, Resolved } from "./project.ts";

/**
 * Where `connectd deploy` puts the project (SvelteKit-adapter style): `target: cloudflare({ name })`
 * in oc.config.ts. The config is bundled into the deployed runtime, so a target there is data only:
 * the module that deploys (`adapter`, resolved from the project at deploy time) and its options.
 * dev ignores it (memory driver, always local).
 */
export type Target = { adapter: string; options: Record<string, unknown> };

/**
 * What a target's `setup` gets (#86): `connectd init` calls it after installing the target's packages,
 * and `deploy` before deploying, so the target's own tool is installed and signed in (Cloudflare:
 * wrangler, `wrangler login`).
 */
export type SetupContext = {
  dir: string;
  env: Env;
  log: (line: string) => void;
  /** Questions for the person at the terminal; absent in CI and tests, where setup says what to do instead. */
  prompts?: Prompts;
  /** Install dev dependencies with the project's package manager; false when it failed. */
  install(packages: string[]): boolean;
  /** The deploy tool's binary, when the caller names one (tests). */
  bin?: string;
};

/** What the CLI hands an adapter: the project resolved against the production env, and the secrets to set. */
export type DeployContext = Omit<SetupContext, "bin"> & {
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
   * key versions 1..`versions`: the same values on every call. A deploy sends only the ones the
   * deployment doesn't hold yet, and never replaces one it holds.
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

/** An adapter module's export. `setup` readies the target's tool (installed, signed in); deploy calls it too. */
export type Adapter = { deploy(ctx: DeployContext): Promise<Deployed>; setup?(ctx: SetupContext): Promise<void> };

/** The questions the CLI asks in a terminal (init's setup, deploy's wrangler checks). Tests pass their own. */
export type Prompts = {
  /** One of `choices`; Enter picks the first. */
  choose(question: string, choices: { value: string; label: string }[]): Promise<string>;
  /** Yes or no; Enter gives `fallback`. */
  confirm(question: string, fallback?: boolean): Promise<boolean>;
  /** A line of text; Enter gives `fallback`. */
  text(question: string, fallback: string): Promise<string>;
  /** Several of `choices`, ticked in a list. A choice with `alone` (e.g. "Add later") clears the others, and they clear it. */
  checklist(question: string, choices: Choice[]): Promise<string[]>;
};

export type Choice = { value: string; label: string; hint?: string; alone?: boolean };
