import { listen } from "@connectd/sdk";

// Runs in the Next app (through oc.routes), never in the runtime.
export default listen("github")
  .on("connection.active", (e) => console.log(`github connected for ${e.connection.id}`))
  .on("connection.reauth_required", (e) => console.log(`github needs a new login for ${e.connection.id}`))
  .on("*", (e) => console.log(`connectd event ${e.type}`));
