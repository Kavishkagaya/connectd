import { connection } from "@openconnect/connections";

/** A connection of your own, next to the bundled providers: an API key, proxied as a header. Edit it while `openconnect dev` runs. */
export default connection()
  .config()
  .auth((f) => f.apiKey("key"))
  .api({ baseUrl: "https://notes.example.com/api", key: { header: "x-api-key" } });
