/**
 * `connectd add --custom <id> --template <flow>`: a starting connection.ts for a provider the catalog
 * doesn't have. Same shape as a copied provider (a `connection()` builder, default export, env read
 * in `.config`), so from here custom and catalog connections are the same code. example.com URLs
 * mark what to fill in.
 */

export const TEMPLATES = ["oauth2", "oidc", "api-key", "client-credentials", "jwt-bearer", "device"] as const;
export type Template = (typeof TEMPLATES)[number];

/** `my-crm` → `MY_CRM`; a leading digit gets a `_` (env names can't start with one). */
const prefix = (id: string) => id.toUpperCase().replace(/-/g, "_").replace(/^(\d)/, "_$1");

const identity = (id: string) => `  // Who the credential belongs to; a throw rejects it. Its fields are the connection's identity.
  .identity(async ({ api }) => {
    const res = await api.fetch("/me");
    if (!res.ok) throw new Error(\`${id} /me \${res.status}\`);
    const me = (await res.json()) as { id: string | number };
    return { id: String(me.id) };
  })`;

const oauthConfig = (p: string) => `.config<OAuth2Config>((env) => ({ clientId: env("${p}_CLIENT_ID"), clientSecret: env("${p}_CLIENT_SECRET") }))`;

/** The template's connection.ts (after the header line) and the env names it reads. */
export function template(t: Template, id: string): { source: string; env: string[] } {
  const p = prefix(id);
  const client = [`${p}_CLIENT_ID`, `${p}_CLIENT_SECRET`];
  switch (t) {
    case "oauth2":
      return {
        env: client,
        source: `import { connection, type OAuth2Config } from "@connectd/connections";

/** ${id}: OAuth 2.0 authorization code with PKCE. The provider's endpoints, scopes and API base URL go here. */
export default connection()
  ${oauthConfig(p)}
  .auth((f) =>
    f
      .oauth2({
        authorizeUrl: "https://example.com/oauth/authorize",
        tokenUrl: "https://example.com/oauth/token",
        // revokeUrl: "https://example.com/oauth/revoke",
      })
      .scopes("read"),
  )
  .api({ baseUrl: "https://api.example.com" })
${identity(id)};
`,
      };
    case "oidc":
      return {
        env: client,
        source: `import { connection, type OAuth2Config } from "@connectd/connections";

/** ${id}: OpenID Connect. Endpoints come from the issuer's discovery document; the verified id_token's claims are the identity. */
export default connection()
  ${oauthConfig(p)}
  .auth((f) => f.oidc({ issuer: "https://example.com" }).scopes("openid", "email", "profile"))
  .external((claims) => ({ sub: String(claims.sub) }));
`,
      };
    case "api-key":
      return {
        env: [],
        source: `import { connection } from "@connectd/connections";

/** ${id}: an API key the user enters (the connect UI shows a form with these fields). */
export default connection()
  .config()
  .auth((f) => f.apiKey("key"))
  // How the key goes on each request: a header here; without \`key\` it's \`Authorization: Bearer <key>\`.
  .api({ baseUrl: "https://api.example.com", key: { header: "x-api-key" } })
${identity(id)};
`,
      };
    case "client-credentials":
      return {
        env: client,
        source: `import { connection, type OAuth2Config } from "@connectd/connections";

/** ${id}: the app's own token (client credentials grant). No user; minted again when it expires. */
export default connection()
  ${oauthConfig(p)}
  .auth((f) => f.clientCredentials({ tokenUrl: "https://example.com/oauth/token" }).scopes("read"))
  .api({ baseUrl: "https://api.example.com" });
`,
      };
    case "jwt-bearer":
      return {
        env: [`${p}_CLIENT_EMAIL`, `${p}_PRIVATE_KEY`],
        source: `import { connection, type ServiceAccount } from "@connectd/connections";

/** ${id}: a JWT signed with a service account's key, traded for a token (RFC 7523). \`connect({ subject })\` acts as that user. */
export default connection()
  .config<ServiceAccount>((env) => ({ clientEmail: env("${p}_CLIENT_EMAIL"), privateKey: env("${p}_PRIVATE_KEY") }))
  .auth((f) => f.jwtBearer({ tokenUrl: "https://example.com/oauth/token" }).scopes("read"))
  .api({ baseUrl: "https://api.example.com" });
`,
      };
    case "device":
      return {
        env: client,
        source: `import { connection, type OAuth2Config } from "@connectd/connections";

/** ${id}: device authorization (RFC 8628). \`connect()\` returns a code to show; the runtime polls until the user approves. */
export default connection()
  ${oauthConfig(p)}
  .auth((f) => f.device({ deviceUrl: "https://example.com/oauth/device/code", tokenUrl: "https://example.com/oauth/token" }).scopes("read"))
  .api({ baseUrl: "https://api.example.com" })
${identity(id)};
`,
      };
  }
}
