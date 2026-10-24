import { listen } from "@connectd/sdk";

// The app's handlers for github's events. This file runs in your app (through oc.routes), never in
// the runtime: `connectd dev` collects it into .connectd/app.ts. Types come from .connectd/registry.d.ts.
export default listen("github")
  .on("connection.active", (e) => console.log(`github connected for ${e.connection.id}`))
  .on("connection.reauth_required", (e) => console.log(`github needs a new login for ${e.connection.id}`))
  .on("webhook.push", (e) => console.log("push", e.data.delivery));
