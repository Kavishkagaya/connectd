import { connection } from "@openconnect/connections";

/** A definition of your own, next to the bundled providers: an API-key connection, proxied with the key as a header. Edit it while `openconnect dev` runs. */
export const notes = connection("notes")
  .config()
  .auth((f) => f.apiKey("key"))
  .api({ baseUrl: "https://notes.example.com/api", key: { header: "x-api-key" } });
