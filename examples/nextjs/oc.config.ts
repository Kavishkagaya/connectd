import { defineConfig } from "@connectd/cli";
import { cloudflare } from "@connectd/cloudflare";

// APP_URL is the Next app's origin: `connectd dev -- next dev` sets it (http://localhost:3000, or
// --app-port), so it's written nowhere else. In production, set it in .env.production.
export default defineConfig((env) => ({
  dir: "src/oc",
  target: cloudflare({ name: "connectd-nextjs" }),
  events: { url: `${env.APP_URL}/api/connectd/events` },
  sessions: { origins: [env.APP_URL as string] },
}));
