import type { Target } from "@kavishkagaya/connectd";

/**
 * Deploy to your own Cloudflare account (#31, #54): a Worker in front, a Durable Object per
 * connection, D1 for the connection index, through wrangler.
 *
 *   // oc.config.ts
 *   import { cloudflare } from "@kavishkagaya/connectd-cloudflare";
 *   export default defineConfig({ dir: "src/oc", target: cloudflare({ name: "my-app" }) });
 *
 * Data only (oc.config.ts is bundled into the Worker): `connectd deploy` loads the adapter
 * (`@kavishkagaya/connectd-cloudflare/adapter`, Node) at deploy time.
 */
export type CloudflareOptions = {
  /** The Worker's name. Default: the project directory's. `--name` overrides it. */
  name?: string;
  /** Its public URL when it isn't the workers.dev one (a custom domain, served at its root). `--url` overrides it. */
  url?: string;
  /**
   * Per `--env` (staging, preview): the Worker's name (default `<name>-<env>`) and URL (default its
   * workers.dev one). Production is the plain `name` and `url` above.
   */
  environments?: Record<string, { name?: string; url?: string }>;
};

export const cloudflare = (options: CloudflareOptions = {}): Target => ({ adapter: "@kavishkagaya/connectd-cloudflare/adapter", options });
