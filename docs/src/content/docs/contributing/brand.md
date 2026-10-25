---
title: Brand and palette
description: The connectd name, logo, colours and type, for the docs, the dashboard, posts and anything else that carries the name.
sidebar:
  order: 4
---

<div class="oc-brand-hero">
  <img src="/favicon.svg" alt="" width="72" height="72" />
  <div>
    <p class="oc-brand-word">connect<span>d</span></p>
    <p class="oc-brand-sub">The connect daemon: it keeps your users' connections alive in the background.</p>
  </div>
</div>

## The name

In Unix, a trailing **d** marks a daemon: a background process that keeps running and does a job for you, like `sshd`, `httpd` or `systemd`. **connectd** is the connect daemon. You write `connect`, and the daemon does the rest: refreshing tokens, renewing webhooks, retrying events.

That's why the "d" is highlighted in the wordmark. It's the part that works for you.

- In the wordmark (headers, posts, the README banner): `connect` in graphite, the `d` on a yellow block, set in IBM Plex Mono.
- In running text: plain **connectd**, always lowercase, no highlight.

## Logo

The mark is a rounded tile with a “c” whose open end meets a node. The node is the live connection, the same idea as the highlighted “d”.

| File | Use |
| --- | --- |
| `docs/src/assets/logo-light.svg` | Graphite tile, yellow node: on light backgrounds |
| `docs/src/assets/logo-dark.svg` | Yellow tile, graphite mark: on dark backgrounds |
| `docs/public/favicon.svg` | The light version, which reads on either |

- Keep clear space around the mark of at least a quarter of its width.
- Don't recolour, rotate or outline it, and don't put it on a busy image.

## Colour: Signal

Graphite and cool paper, with one highlighter yellow: the light that says a connection is live.

<div class="oc-swatches">
  <div class="oc-swatch-row"><span class="oc-swatch-name">Signal</span>
    <i style="--c:#FFF4C7">soft</i><i style="--c:#FFE58A">300</i><i style="--c:#FFD23F">signal</i><i style="--c:#D9A900">edge</i>
  </div>
  <div class="oc-swatch-row"><span class="oc-swatch-name">Light</span>
    <i style="--c:#FFFFFF">white</i><i style="--c:#F4F5F3">paper</i><i style="--c:#ECEDE9">raised</i><i style="--c:#E0E1DD">line</i><i style="--c:#C8CAC4">line+</i><i style="--c:#5A5D63" class="d">muted</i><i style="--c:#3B3E44" class="d">ink 2</i><i style="--c:#16171A" class="d">graphite</i>
  </div>
  <div class="oc-swatch-row"><span class="oc-swatch-name">Dark</span>
    <i style="--c:#ECEDEA">text</i><i style="--c:#9DA0A6">muted</i><i style="--c:#3A3D42" class="d">line+</i><i style="--c:#2A2C30" class="d">line</i><i style="--c:#1F2023" class="d">raised</i><i style="--c:#18191C" class="d">surface</i><i style="--c:#111214" class="d">night</i>
  </div>
  <div class="oc-swatch-row"><span class="oc-swatch-name">Status</span>
    <i style="--c:#2F9E5B" class="d">success</i><i style="--c:#E8590C" class="d">caution</i><i style="--c:#D6334A" class="d">danger</i>
  </div>
</div>

**The one rule: yellow is a fill, never text on a light background.** Use it behind graphite text (highlights, the current page, primary buttons, the wordmark's “d”) or as a line (link underlines, the active tab). In dark mode yellow text is fine, at 13:1.

| Role | Light | Dark |
| --- | --- | --- |
| Page background | paper `#F4F5F3` | night `#111214` |
| Surface (cards, tables, diagrams) | white `#FFFFFF` | `#18191C` |
| Border | `#E0E1DD` | `#2A2C30` |
| Text | graphite `#16171A` | `#ECEDEA` |
| Secondary text | `#3B3E44` | `#C9CBC7` |
| Muted text | `#5A5D63` | `#9DA0A6` |
| Links | graphite, yellow underline | yellow `#FFD23F` |
| Highlight, current page, primary button | yellow fill, graphite text | yellow fill, graphite text |
| Code blocks (both themes) | `#1C1D21`, border `#3A3D42` | `#1C1D21`, border `#3A3D42` |

Every text pairing is at least **6:1** against its background (WCAG AA needs 4.5:1): graphite on paper 16.4:1, muted on paper 6.0:1, graphite on yellow 12.4:1, yellow on night 13.0:1.

The tokens live at the top of `docs/src/styles/custom.css`. Change them there, not per component.

## Type

| Use | Font | Notes |
| --- | --- | --- |
| Headings | Schibsted Grotesk | 700–800 weight, tight tracking |
| Text | IBM Plex Sans | 16px at 1.7 line height in the docs |
| Code, labels, the wordmark | IBM Plex Mono | Ligatures off, so `=>` and `!==` stay as typed |
| Diagrams | The system UI font | No web-font swap after Mermaid measures the labels |

All three are bundled with the site (`@fontsource`), so pages make no requests to font CDNs.

## Images for posts

Square, 1200 × 1200. Night background, the wordmark top left, the post number top right, one headline in Schibsted Grotesk with its key phrase in yellow, and supporting detail in IBM Plex. One yellow element per image beyond the wordmark, so the highlight still means something.
