import { defineConfig } from "@connectd/cli";
import { cloudflare } from "@connectd/cloudflare";

// APP_URL is the Next app's origin, from .env (and .env.production when deployed): written once.
export default defineConfig((env) => ({
  dir: "src/oc",
  target: cloudflare({ name: "connectd-nextjs" }),
  events: { url: `${env.APP_URL}/api/connectd/events` },
  sessions: { origins: [env.APP_URL as string] },
}));
