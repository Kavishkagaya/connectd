---
title: Contributing
description: How the repo is laid out, how to run it, and how work is planned, decided and reviewed.
sidebar:
  order: 1
  label: Overview
---

connectd is Apache-2.0 and built in the open. Contributions are welcome: providers, platforms, fixes, docs, and the hard questions in design issues.

## Ways to help

- **Add a provider** to the catalog. The most direct value. See [adding a provider](/contributing/providers/).
- **Fix or improve docs.** Every page has an *Edit page* link. See [docs](/contributing/docs/).
- **Pick up an issue.** Work is planned as [GitHub issues](https://github.com/Kavishkagaya/connectd/issues), with epics per layer and [#1](https://github.com/Kavishkagaya/connectd/issues/1) as the roadmap.
- **Build a platform or a target**: a server platform (Postgres, SQLite) is on the roadmap.
- **Report bugs** with a failing test where you can. The memory platform makes most bugs reproducible in a few lines.

## Setup

```sh
git clone https://github.com/Kavishkagaya/connectd
cd connectd
bun install          # Bun 1.3+
bun run test         # bun tests under src/, plus vitest in workerd under test/
bun run typecheck    # tsc in every type environment (Node, Workers, DOM)
```

Try it end to end with the examples:

```sh
cd examples/basic
bunx connectd init   # once: dev's keys into .env
bun run dev          # connectd dev on :8787
```

## The repo

```text
packages/
  kernel/        L1 + L0: the tools (cell, timer, queue, …) and the platform contract with its implementations (memory, do, parity)
  connections/   L2: connection() builder, auth flows, lifecycle, OAuth atoms, testing harness
  runtime/       L3: host, HTTP routes, proxy, events, webhooks, sessions, index, actions
  sdk/           L4: the server SDK (fetch only)
  connect/       L4: the browser package (DOM only, zero dependencies)
  cli/           L4: the connectd command
  cloudflare/    L4: the Cloudflare deploy target
  dashboard/     L4: the self-host dashboard extension
  providers/     the catalog's source (private, never published)
registry/        generated from providers/, what `connectd add` copies
examples/        basic (every provider + a custom one) and nextjs (end to end)
docs/            this site (Astro Starlight)
DECISIONS.md     one entry per design issue: why things are the way they are
CLAUDE.md        a dense map of the codebase
```

[`CLAUDE.md`](https://github.com/Kavishkagaya/connectd/blob/main/CLAUDE.md) has a line for every source file, so read it first.

## The rules that keep it simple

- **A layer only uses the one below it.** The kernel never imports Cloudflare. `cloudflare:workers` appears in exactly three files.
- **Kernel = mechanism.** A tool that mentions a connection, token or provider isn't kernel code.
- **Races go through `cas` or `take`.** Handlers interleave at every `await`, and the memory platform deliberately doesn't serialize, so tests catch races.
- **Time is `atom.now()` / `platform.now()`**, never `Date.now()`.
- **Small, minimal code.** No abstraction without a second use.
- **Deliberate shortcuts are marked** with a `// ponytail:` comment that names the limit and the upgrade path:

  ```ts
  // ponytail: one fixed base URL; a function of the credential when a provider needs a per-connection host (Salesforce instance_url).
  ```

  These are known, accepted limits. Grepping for `ponytail:` gives you a list of good first improvements.
- **Strict TypeScript** with `noUncheckedIndexedAccess`, and `.ts` extensions in imports.

## Tests

| What | Where | Runner |
| --- | --- | --- |
| Kernel tools, lifecycle, flows, runtime, SDK, CLI | `src/*.test.ts` next to each file | `bun test` |
| Platform equivalence | `kernel/src/drivers/parity.ts` (`parity`, `platformParity`) | memory under Bun, Durable Objects + D1 under vitest in workerd |
| The Cloudflare platform, the Cloudflare runtime, the generated Worker | `test/` | vitest (workerd) |
| Providers | `providers/src/providers.test.ts`, against fakes | `bun test` |
| Real browser | `packages/*/e2e/chromium.ts` | By hand, with Playwright |

New platform behaviour goes into **parity**, not one platform's tests. One file: `cd packages/kernel && bun test src/limiter.test.ts`.

## Process

```mermaid
flowchart LR
  I["Issue"] --> D["Discussion"] --> DEC["DECISIONS.md"] --> PR["PR"] --> R["Merge"]
```

1. **Issues first.** Design work is a deep-dive issue under its layer's epic.
2. **Decisions are recorded.** Each deep dive's outcome goes into `DECISIONS.md`: one entry per issue, newest last, marked *decided* or *provisional*, with the reasoning and what was rejected.
3. **Everything goes through PRs.** Branch off `main` and never commit to `main` directly. Reference the issue (`Closes #54`).
4. **Generated files are committed and checked.** If you change a provider, run `cd packages/providers && bun run registry`. If you change the dashboard UI, run `cd packages/dashboard && bun run build`. A test fails when either is stale.

## Packaging

```sh
bun run pack   # every package built to JavaScript and npm-packed into .pack/
```

Install the tarballs in a scratch project to try `npx connectd` on plain Node.
