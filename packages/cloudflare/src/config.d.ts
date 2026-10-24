// The user's oc.config.ts, as the Worker entry template (worker.ts) imports it.
declare module "connectd:config" {
  const config: import("@connectd/cli").Config;
  export default config;
}
