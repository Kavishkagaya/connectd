// No imports: the deploy generator and its vitest config (Node) use these too.

/** The environment the runtime reads. `CONNECTD_KEY_V<n>`: encryption keys by version, the highest is current (#10). */
export const ENV = {
  url: "CONNECTD_PUBLIC_URL",
  apiKey: "CONNECTD_API_KEY",
  key: "CONNECTD_KEY_V",
  state: "CONNECTD_STATE_KEY",
  sessions: "CONNECTD_SESSIONS_KEY",
  webhooks: "CONNECTD_WEBHOOKS_KEY",
  events: "CONNECTD_EVENTS_SECRET",
} as const;

const random = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

/** Fresh values for every generated secret: `connectd init` writes dev's into .env, deploy sets an environment's as Worker secrets. */
export const generateKeys = (): Record<string, string> => ({
  [ENV.apiKey]: `oc_${random().replace(/[+/=]/g, "").slice(0, 32)}`,
  [`${ENV.key}1`]: random(),
  [ENV.state]: random(),
  [ENV.sessions]: random(),
  [ENV.webhooks]: random(),
  [ENV.events]: `whsec_${random()}`,
});
