# connectd

An OAuth connection platform with an open-source self-host path and a low-cost managed service on Cloudflare. A full solution (SDK, CLI, events, webhooks), not just an HTTP API.

> Status: not released yet, still being built. See the [roadmap](https://github.com/Kavishkagaya/connectd/issues/1).

## Architecture

```
 L4  DevX        SDK (server + frontend connect UI) · CLI (dev / deploy) · dashboard
 L3  Runtime     proxy · webhook ingress · event/trigger delivery to user's server
 L2  Connections defineConnection(): lifecycle, OAuth, auth flow, rate policy, webhooks
 L1  Kernel      management of one instance: cell · flight · mutex · timer · queue · ticket · limiter · seal
 L0  Drivers     Durable Objects (prod) · in-memory (dev/tests) · server (deferred)
```

## License

[Apache 2.0](LICENSE)
