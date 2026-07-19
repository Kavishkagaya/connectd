/** Static OAuth config for a provider — everything except a specific team's client_id/secret. */
export type ProviderConfig = {
  service: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  scopeSeparator: " " | ",";
  pkceRequired: boolean;
  tokenEndpointAuthMethod: "client_secret_basic" | "client_secret_post";
  multiTenant: boolean;
};

export const PROVIDERS = {
  github: {
    service: "github",
    authorizationEndpoint: "https://github.com/login/oauth/authorize",
    tokenEndpoint: "https://github.com/login/oauth/access_token",
    scopeSeparator: " ",
    pkceRequired: false,
    tokenEndpointAuthMethod: "client_secret_post",
    multiTenant: true,
  },
  slack: {
    service: "slack",
    authorizationEndpoint: "https://slack.com/oauth/v2/authorize",
    tokenEndpoint: "https://slack.com/api/oauth.v2.access",
    revocationEndpoint: "https://slack.com/api/auth.revoke",
    scopeSeparator: ",",
    pkceRequired: false,
    tokenEndpointAuthMethod: "client_secret_post",
    multiTenant: true,
  },
  google: {
    service: "google",
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    revocationEndpoint: "https://oauth2.googleapis.com/revoke",
    scopeSeparator: " ",
    pkceRequired: true,
    tokenEndpointAuthMethod: "client_secret_post",
    multiTenant: false,
  },
} as const satisfies Record<string, ProviderConfig>;

export type ProviderName = keyof typeof PROVIDERS;

export function isProviderName(value: string): value is ProviderName {
  return value in PROVIDERS;
}
