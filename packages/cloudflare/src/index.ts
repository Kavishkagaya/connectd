import type { Target } from "@connectd/cli";

/**
 * Deploy to your own Cloudflare account (#31, #54): a Worker in front, a Durable Object per
 * connection, D1 for the connection index, through wrangler.
 *
 *   // oc.config.ts
 *   import { cloudflare } from "@connectd/cloudflare";
 *   export default defineConfig({ dir: "src/oc", target: cloudflare({ name: "my-app" }) });
 *
 * Data only (oc.config.ts is bundled into the Worker): `connectd deploy` loads the adapter
 * (`@connectd/cloudflare/adapter`, Node) at deploy time.
 */
export type CloudflareOptions = {
  /** The Worker's name. Default: the project directory's. `--name` overrides it. */
  name?: string;
  /** Its public URL when it isn't the workers.dev one (a custom domain, served at its root). `--url` overrides it. */
  url?: string;
};

export const cloudflare = (options: CloudflareOptions = {}): Target => ({ adapter: "@connectd/cloudflare/adapter", options });
