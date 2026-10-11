# openconnect

An OAuth connection platform with an open-source self-host path and a low-cost managed service on Cloudflare. A full solution (SDK, CLI, events, webhooks), not just an HTTP API.

> Status: starting over. See the [roadmap](https://github.com/Kavishkagaya/openconnect/issues/1).

## Architecture

```
 L4  DevX        SDK (server + frontend connect UI) · CLI (dev / deploy) · dashboard
 L3  Runtime     proxy · webhook ingress · event/trigger delivery to user's server
 L2  Connections defineConnection(): auth flow, rate policy, webhooks, lifecycle hooks
 L1  Kernel      primitives: lifecycle · tokens · rate · secrets · schedule · oauth atoms
 L0  Drivers     Durable Objects (prod) · in-memory (dev/tests) · server (deferred)
```

## License

[Apache 2.0](LICENSE)
