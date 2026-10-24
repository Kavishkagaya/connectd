import { apiKey, defineConnection, oauth2 } from "@openconnect/connections";
import { defineConfig } from "../../src/project.ts";

// The project the workerd test deploys: its generated Worker entry runs the real runtime in workerd.
export default defineConfig((env) => ({
  definitions: [
    defineConnection({ id: "keyed", auth: apiKey(["key"]), proxy: { baseUrl: "https://upstream.test/v1", inject: { query: "api_key" } } }),
    defineConnection({ id: "example", auth: oauth2({ authorizeUrl: "https://provider.test/authorize", tokenUrl: "https://provider.test/token" }) }),
  ],
  config: { example: { clientId: env.EXAMPLE_CLIENT_ID ?? "", clientSecret: env.EXAMPLE_CLIENT_SECRET } },
  deploy: { name: "fixture" },
}));
