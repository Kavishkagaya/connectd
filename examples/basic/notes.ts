import { apiKey, defineConnection } from "@openconnect/connections";

/** A definition of your own, next to the bundled providers: an API-key connection, proxied with the key as a header. Edit it while `openconnect dev` runs. */
export const notes = defineConnection({
  id: "notes",
  auth: apiKey(["key"]),
  proxy: { baseUrl: "https://notes.example.com/api", inject: { header: "x-api-key" } },
});
