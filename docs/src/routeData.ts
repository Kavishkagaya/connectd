import { defineRouteMiddleware } from "@astrojs/starlight/route-data";

// Hero buttons are written root-absolute in frontmatter ("/start/quickstart/"); Starlight uses them as
// is, so they get the site's base here (Markdown links get it in astro.config.mjs).
const base = import.meta.env.BASE_URL.replace(/\/$/, "");

export const onRequest = defineRouteMiddleware((context) => {
  const hero = context.locals.starlightRoute.entry.data.hero;
  if (!base || !hero?.actions) return;
  hero.actions = hero.actions.map((a) => (a.link.startsWith("/") && !a.link.startsWith(`${base}/`) ? { ...a, link: base + a.link } : a));
});
