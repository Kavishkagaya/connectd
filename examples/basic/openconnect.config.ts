import { defineConfig } from "@openconnect/cli";
import { github, google, slack } from "@openconnect/providers";
import { profile } from "./actions.ts";
import { notes } from "./notes.ts";

// `openconnect dev` in this directory. Provider credentials go in .dev.vars (see .dev.vars.example);
// a provider without them answers not_configured until they're set.
export default defineConfig((env) => ({
  definitions: [github, slack, google, notes],
  actions: [profile],
  config: {
    ...(env.GITHUB_CLIENT_ID ? { github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET } } : {}),
    ...(env.SLACK_CLIENT_ID ? { slack: { clientId: env.SLACK_CLIENT_ID, clientSecret: env.SLACK_CLIENT_SECRET, signingSecret: env.SLACK_SIGNING_SECRET } } : {}),
    ...(env.GOOGLE_CLIENT_ID ? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } } : {}),
  },
  // Your app's endpoint for signed events (`oc.events({ secret }).handle`, @openconnect/sdk).
  ...(env.EVENTS_URL ? { events: { url: env.EVENTS_URL } } : {}),
  // Pages that run the connect UI (@openconnect/connect).
  sessions: { origins: [env.APP_ORIGIN ?? "http://localhost:3000"] },
}));
