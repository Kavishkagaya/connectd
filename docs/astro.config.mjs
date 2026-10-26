import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import mermaid from "astro-mermaid";

const LANGS = { ts: "typescript", tsx: "tsx", js: "javascript", mjs: "javascript", sh: "bash", bash: "bash", json: "json", yaml: "yaml", yml: "yaml", md: "markdown", html: "html" };

/** Puts the language name in every code block's header: as the title when there is none, after the title otherwise. */
function languageLabel() {
  const label = (lang) => (lang === "text" || lang === "txt" || lang === "plaintext" ? null : (LANGS[lang] ?? lang));
  return {
    name: "language-label",
    hooks: {
      preprocessMetadata({ codeBlock }) {
        const l = label(codeBlock.language);
        if (l && !codeBlock.props.title && !codeBlock.metaOptions.getString("title")) codeBlock.props.title = l;
      },
      postprocessRenderedBlock({ codeBlock, renderData }) {
        const l = label(codeBlock.language);
        if (!l || codeBlock.props.title === l) return;
        // Append <span class="ec-lang"> inside the title (its ::after is the frames plugin's tab marker).
        const find = (n) => (n.type === "element" && [n.properties?.className ?? []].flat().includes("title") ? n : (n.children ?? []).map(find).find(Boolean));
        const title = find(renderData.blockAst);
        if (title) title.children.push({ type: "element", tagName: "span", properties: { className: ["ec-lang"] }, children: [{ type: "text", value: l }] });
      },
    },
  };
}

/**
 * Keeps diagram source out of the search index. Runs before astro-mermaid's own step (which is
 * appended after this one) and emits the same `<pre class="mermaid">`, plus `data-pagefind-ignore`.
 */
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const diagramsOutOfSearch = {
  name: "diagrams-out-of-search",
  code: (node) => (node.lang === "mermaid" ? { type: "html", value: `<pre class="mermaid" data-pagefind-ignore>${esc(node.value)}</pre>` } : undefined),
};

/**
 * Adds the two Markdown steps above to Astro's own (Sätteri) processor, the way Starlight and Expressive
 * Code register theirs. Listed after astro-mermaid (which swaps in its own processor) so it sees that one.
 */
const markdownSteps = {
  name: "connectd-markdown-steps",
  hooks: {
    "astro:config:setup": ({ config }) => {
      const p = config.markdown?.processor;
      if (p?.name !== "satteri" || !Array.isArray(p.options?.mdastPlugins)) throw new Error("connectd docs: expected Astro's Sätteri Markdown processor");
      if (!p.options.mdastPlugins.includes(diagramsOutOfSearch)) p.options.mdastPlugins.unshift(diagramsOutOfSearch); // before astro-mermaid's own step
      if (!p.options.mdastPlugins.includes(baseLinks)) p.options.mdastPlugins.push(baseLinks);
    },
  },
};

// GitHub Pages serves a project site under /<repo>/. On a custom domain: set `site` to it and BASE to "".
const BASE = "/connectd";

/**
 * Internal links are written root-absolute (`/guides/events/`) and get the base here, so they work
 * whether or not the page URL ends in a slash (relative links don't), and survive a base change.
 */
const withBase = (url) => (BASE && url.startsWith("/") && !url.startsWith("//") && !url.startsWith(`${BASE}/`) ? BASE + url : url);
const baseLinks = {
  name: "base-links",
  link: (node) => ({ ...node, url: withBase(node.url) }),
  image: (node) => ({ ...node, url: withBase(node.url) }),
  definition: (node) => ({ ...node, url: withBase(node.url) }),
  html: (node) => ({ ...node, value: node.value.replace(/\b(src|href)="(\/[^"]*)"/g, (_, a, u) => `${a}="${withBase(u)}"`) }),
};

export default defineConfig({
  site: "https://kavishkagaya.github.io",
  base: BASE || undefined,
  integrations: [
    // Before starlight, so its code blocks don't swallow ```mermaid.
    // `base` theme in both modes: the colours come from the site's tokens (custom.css), so no re-render on theme change.
    mermaid({
      theme: "base",
      autoTheme: false,
      enableLog: false,
      mermaidConfig: {
        look: "classic",
        themeVariables: { fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif", fontSize: "14px" },
        flowchart: { curve: "basis", padding: 14, nodeSpacing: 36, rankSpacing: 64, htmlLabels: true },
        sequence: { wrap: true, width: 128, actorMargin: 28, boxMargin: 8, noteMargin: 10, messageMargin: 30, mirrorActors: false },
        state: { padding: 10 },
      },
    }),
    markdownSteps,
    starlight({
      title: "connectd",
      description: "OAuth connections for your app: tokens, refresh, webhooks, events and rate limits, run for you.",
      logo: { light: "./src/assets/logo-light.svg", dark: "./src/assets/logo-dark.svg", alt: "" },
      components: { SiteTitle: "./src/components/SiteTitle.astro" },
      favicon: "/favicon.svg",
      routeMiddleware: "./src/routeData.ts",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/Kavishkagaya/connectd" }],
      editLink: { baseUrl: "https://github.com/Kavishkagaya/connectd/edit/main/docs/" },
      customCss: [
        "@fontsource-variable/schibsted-grotesk",
        "@fontsource-variable/ibm-plex-sans",
        "@fontsource/ibm-plex-mono/400.css",
        "@fontsource/ibm-plex-mono/500.css",
        "@fontsource/ibm-plex-mono/600.css",
        "./src/styles/custom.css",
      ],
      // One graphite code theme in both light and dark mode.
      expressiveCode: {
        themes: ["vitesse-black"],
        plugins: [languageLabel()],
        // Long lines wrap inside the block (indented like the line they continue) instead of scrolling sideways.
        defaultProps: { wrap: true, preserveIndent: true },
        styleOverrides: {
          codeFontFamily: "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
          codeFontSize: "0.875rem",
          uiFontFamily: "'IBM Plex Sans Variable', system-ui, sans-serif",
          borderRadius: "0.75rem",
          // A step lighter than the dark page, with a visible border, so a block stands out in both themes; yellow marks the active tab.
          codeBackground: "#1c1d21",
          borderColor: "#3a3d42",
          frames: {
            editorBackground: "#1c1d21",
            terminalBackground: "#1c1d21",
            editorTabBarBackground: "#141518",
            editorActiveTabBackground: "#1c1d21",
            editorActiveTabIndicatorTopColor: "#ffd23f",
            editorActiveTabIndicatorBottomColor: "transparent",
            editorTabBarBorderBottomColor: "#3a3d42",
            terminalTitlebarBackground: "#141518",
            terminalTitlebarBorderBottomColor: "#3a3d42",
            frameBoxShadowCssValue: "none",
          },
        },
      },
      sidebar: [
        { label: "Start here", items: [{ autogenerate: { directory: "start" } }] },
        { label: "Concepts", items: [{ autogenerate: { directory: "concepts" } }] },
        { label: "Guides", items: [{ autogenerate: { directory: "guides" } }] },
        { label: "Extending", items: [{ autogenerate: { directory: "extending" } }] },
        { label: "Reference", items: [{ autogenerate: { directory: "reference" } }] },
        { label: "Contributing", items: [{ autogenerate: { directory: "contributing" } }] },
      ],
    }),
  ],
});
