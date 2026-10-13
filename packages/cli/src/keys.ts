// No imports: the deploy generator and its vitest config (Node) use these too.

/** The environment the runtime reads. `OPENCONNECT_KEY_V<n>`: encryption keys by version, the highest is current (#10). */
export const ENV = {
  url: "OPENCONNECT_PUBLIC_URL",
  apiKey: "OPENCONNECT_API_KEY",
  key: "OPENCONNECT_KEY_V",
  state: "OPENCONNECT_STATE_KEY",
  sessions: "OPENCONNECT_SESSIONS_KEY",
  webhooks: "OPENCONNECT_WEBHOOKS_KEY",
  events: "OPENCONNECT_EVENTS_SECRET",
} as const;

const random = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

/** Fresh values for every generated secret: dev keeps them in `.openconnect/dev.vars`, deploy sets them as Worker secrets. */
export const generateKeys = (): Record<string, string> => ({
  [ENV.apiKey]: `oc_${random().replace(/[+/=]/g, "").slice(0, 32)}`,
  [`${ENV.key}1`]: random(),
  [ENV.state]: random(),
  [ENV.sessions]: random(),
  [ENV.webhooks]: random(),
  [ENV.events]: `whsec_${random()}`,
});
