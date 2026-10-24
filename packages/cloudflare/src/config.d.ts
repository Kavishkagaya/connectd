// The user's oc.config.ts, as the Worker entry template (worker.ts) imports it.
declare module "openconnect:config" {
  const config: import("./project.ts").Config;
  export default config;
}
