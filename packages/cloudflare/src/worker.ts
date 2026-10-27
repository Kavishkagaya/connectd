// The Worker entry `connectd deploy` generates (#31). This file is the template: the generator
// copies it into .connectd/deploy/ and points each import below at a resolved path. It runs in
// workerd, so it's typechecked with Workers types (tsconfig.workers.json), not by the root tsc.
import { env } from "cloudflare:workers";
import { runtime } from "@kavishkagaya/connectd/runtime";
import { cloudflare, cloudflarePlatform } from "@kavishkagaya/connectd/runtime/cloudflare";
import config from "connectd:config";
import { options } from "@kavishkagaya/connectd";

// The platform: connections' atoms in the CONNECTION Durable Objects, the management db in D1 (INDEX),
// configuration from the Worker's vars and secrets. Module scope: `options` resolves the config against
// the platform's env (definitions are needed up front); keys are imported lazily on the first request,
// since Workers can't do crypto here.
const PLATFORM = { binding: "CONNECTION", db: "INDEX" };
const cf = cloudflare(runtime(options(config, cloudflarePlatform(env as Record<string, unknown>, PLATFORM).env)), PLATFORM);

export class Connection extends cf.ConnectionDO {}
export default { fetch: cf.fetch };
