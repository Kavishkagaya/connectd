// The Worker entry `connectd deploy` generates (#31). This file is the template: the generator
// copies it into .connectd/deploy/ and points each import below at a resolved path. It runs in
// workerd, so it's typechecked with Workers types (tsconfig.workers.json), not by the root tsc.
import { env } from "cloudflare:workers";
import { runtime } from "@connectd/runtime";
import { cloudflare, d1Index } from "@connectd/runtime/cloudflare";
import config from "connectd:config";
import { type Env, options } from "@connectd/cli";

// Module scope: `options` resolves the config against the Worker's vars and secrets (definitions are
// needed up front); keys are imported lazily on the first request, since Workers can't do crypto here.
const cf = cloudflare(runtime(options(config, env as unknown as Env, d1Index("INDEX"))), { binding: "CONNECTION" });

export class Connection extends cf.ConnectionDO {}
export default { fetch: cf.fetch };
