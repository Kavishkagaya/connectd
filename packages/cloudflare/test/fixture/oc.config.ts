import { apiKey, connection, defineConnection, oauth2 } from "@kavishkagaya/connectd-connections";
import { defineConfig } from "@kavishkagaya/connectd";
import { cloudflare } from "../../src/index.ts";

// The project the workerd test deploys: its generated Worker entry runs the real runtime in workerd.
export default defineConfig((env) => ({
  definitions: [
    defineConnection({ id: "keyed", auth: apiKey(["key"]), proxy: { baseUrl: "https://upstream.test/v1", inject: { query: "api_key" } } }),
    defineConnection({ id: "example", auth: oauth2({ authorizeUrl: "https://provider.test/authorize", tokenUrl: "https://provider.test/token" }) }),
    // Its config from the Worker's env (#54, one .env).
    connection("envd")
      .config((e) => ({ clientId: e("ENVD_CLIENT_ID") }))
      .auth((f) => f.oauth2({ authorizeUrl: "https://provider.test/authorize", tokenUrl: "https://provider.test/token" })),
  ],
  config: { example: { clientId: env.EXAMPLE_CLIENT_ID ?? "", clientSecret: env.EXAMPLE_CLIENT_SECRET } },
  target: cloudflare({ name: "fixture" }),
}));
