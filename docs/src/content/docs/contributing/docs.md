---
title: Working on these docs
description: How the docs site is built, written and published.
sidebar:
  order: 3
---

The site is [Astro Starlight](https://starlight.astro.build) in `docs/`, published to GitHub Pages on every push to `main` that changes it.

```sh
cd docs
bun install      # or npm install
bun run dev      # http://localhost:4321/connectd/
bun run build    # static site into docs/dist/
```

## Where things go

```text
docs/src/content/docs/
├── index.mdx          the landing page
├── start/             why, quickstart
├── concepts/          the theory: mental model, lifecycle, architecture, providers as code, security
├── guides/            how to: one task per page
├── extending/         custom providers, extensions, self-hosting
├── reference/         CLI, SDK, HTTP API, config: complete and terse
└── contributing/      this section
```

The sidebar is generated per folder. Order pages with `sidebar.order` in the frontmatter.

## Diagrams

Write [Mermaid](https://mermaid.js.org) in a fenced block. It's rendered in the browser and follows the light/dark theme:

````md
```mermaid
flowchart LR
  A[Your app] --> B[connectd] --> C[(Provider)]
```
````

Prefer a diagram wherever something *moves*: a request, a state change, a flow between parties. Keep labels short. Avoid `<`, `>` and `&` in labels, which Mermaid reads as markup.

## Writing

- **Show the real thing.** Snippets should match the code. When in doubt, copy from `examples/` or the source's doc comments, and run them.
- **Lead with what the reader does**, then explain why.
- **Links between pages are root-absolute** with a trailing slash: `/guides/events/`, not `../events/`. The build adds the site's base path (`/connectd`), so links work whether or not the page URL ends in a slash. Relative links break when it doesn't.
- When behaviour changes in a PR, update the page in the same PR.

## Publishing

`.github/workflows/docs.yml` builds `docs/` and deploys it to GitHub Pages. In the repository settings, **Pages → Source** must be set to **GitHub Actions** (once). On a custom domain, set `site` in `docs/astro.config.mjs` to it and `BASE` to `""`.
