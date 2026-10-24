import { defineConfig } from "@openconnect/cli";
import { cloudflare } from "@openconnect/cloudflare";

// `openconnect dev` in this directory. The connections are the folders in src/oc/ (one each, named
// by its id: connection.ts, actions/); each reads its credentials from .env (see .env.example), and
// answers not_configured until they're set. Only the names read reach the runtime.
export default defineConfig((env) => ({
  dir: "src/oc",
  // Where `openconnect deploy` puts it; dev ignores it.
  target: cloudflare({ name: "basic" }),
  // Your app's endpoint for signed events (`oc.events({ secret }).handle`, @openconnect/sdk).
  ...(env.EVENTS_URL ? { events: { url: env.EVENTS_URL } } : {}),
  // Pages that run the connect UI (@openconnect/connect).
  sessions: { origins: [env.APP_ORIGIN ?? "http://localhost:3000"] },
}));
