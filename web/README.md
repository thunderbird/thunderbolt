# web

The public web surfaces for Thunderbolt, unified as a single Astro project:

- **Landing** — `/` (`src/pages/index.astro`), the marketing home
- **Enterprise** — `/enterprise`, the organization and self-hosting overview
- **Contact** — `/contact` (a React island wrapped in an Astro page). `/announcing-thunderbolt` is a redirect to `/blog/mozilla-introduces-thunderbolt`, configured in `redirects` in `astro.config.mjs`
- **Blog** — `/blog/*` (`src/content/blog/`)
- **Docs** — `/docs/*` (Starlight). The content is not in this directory: `src/loaders/repo-docs-loader.ts` walks the repo-root `/docs/` tree so GitHub and the docs site share one source of truth

## Stack

- Astro 7 (with `@astrojs/react` for marketing islands, `@astrojs/starlight` for docs)
- Tailwind 4 via `@tailwindcss/vite`
- Docs styling is hand-rolled: `src/styles/starlight.css` plus `Head`, `Header`, `PageTitle` and `ThemeSelect` overrides in `src/components/starlight/`, wired up in `astro.config.mjs`
- Blog and docs share Spark’s palette (`src/styles/spark-palette.css`), editorial styles (`src/styles/spark-editorial.css`), and navigation (`SparkHeader` and `spark-chrome.css`). Docs retain Starlight search and sidebar navigation. Blog posts retain their canonical Markdown content and use `BlogPost.astro` for the reading layout.
- Spark, blog, docs, enterprise, and contact share system-based light/dark mode through `src/components/site-theme/`. `ThemeProvider.astro` applies the OS palette before first paint and follows OS changes. Only development builds show a theme toggle and honor the saved `starlight-theme` preview preference; production ignores saved overrides. New themed layouts must include this provider, and colors belong in `spark-palette.css`.
- Spark’s product captures live in `public/images/marketing/screenshots/`. The desktop pair was captured from the native app with [Kottke’s Webb photo story](https://kottke.org/24/02/spectacular-jwst-photos-adorn-new-usps-stamps) in its sidebar; the mobile pair uses the responsive web app. Both contain real generated star-party conversations. Desktop captures trim the native titlebar and the article’s utility column; chat content is unchanged. `ThemedScreenshot` uses a browser-selected `<picture>` source so production downloads only the capture matching the OS. Development uses CSS to support preview overrides before hydration.
- Fontsource for self-hosted fonts (Lora for marketing and blog headings, Mozilla Headline for the wordmark, Inter for body text and docs), imported in `src/styles/tokens.css`. The shared tokens mirror the app’s warm palette and amber-to-raspberry brand gradient

## Commands

Run from this directory:

```bash
bun install
bun run dev          # http://localhost:4321
bun run build        # static output in ./dist
bun run preview      # serve the build locally
```

## Spark design

Spark is the production homepage at `/`, with shared components in `src/components/marketing/spark/`. The old `/designs/spark` preview redirects to `/`; the alternate concepts and font explorer are excluded from the production site.

The shared header’s Explore dropdown links Docs, Blog, Enterprise, and Contact. Add future destinations to the `pages` array in `spark-header.tsx`. Download and community destinations live in `src/data/website-product.ts`; public mobile store URLs are still pending.

## Deploys

The site ships as a container image, not a hosted static-site service. `deploy/docker/marketing.Dockerfile` builds it and **must run with the repo root as its build context** — the docs loader reads `../docs`, so the Dockerfile copies both `web/` and the root `docs/` into the build. `.github/workflows/images-publish.yml` publishes the result as `ghcr.io/thunderbird/thunderbolt/thunderbolt-marketing`; the final stage is nginx-unprivileged listening on 8080 with `deploy/config/marketing-nginx.conf`, deployed by `deploy/k8s/templates/marketing.yaml`. All surfaces (landing, enterprise, contact, blog, docs) are served from one origin at `thunderbolt.io` under subpaths.

## Content

- **New blog post:** add a markdown file under `src/content/blog/`. Frontmatter requires `title`, `description`, `date`, `author`; `tags`, `image`, `draft` are optional.
- **New doc:** add a markdown file under the repo-root `docs/` directory, then register its slug in `astro.config.mjs` under `starlight({ sidebar })` — a doc with no sidebar entry still builds, but nothing links to it. Slugs are `docs/<path-without-.md>`, and a `README.md` or `index.md` collapses to its directory's slug (`docs/using/README.md` → `docs/using`); see `computeSlug` in `src/loaders/repo-docs-loader.ts`. `docs/internals/` is the exception: the loader skips that whole tree (`unpublishedDirs`), so a page added there is contributor documentation and never reaches the site.
