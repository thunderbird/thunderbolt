# web

The public web surfaces for Thunderbolt, unified as a single Astro project:

- **Landing** — `/` (`src/pages/index.astro`), the marketing home
- **Contact** — `/contact` (a React island wrapped in an Astro page). `/announcing-thunderbolt` is a redirect to `/blog/mozilla-introduces-thunderbolt`, configured in `redirects` in `astro.config.mjs`
- **Blog** — `/blog/*` (`src/content/blog/`)
- **Docs** — `/docs/*` (Starlight). The content is not in this directory: `src/loaders/repo-docs-loader.ts` walks the repo-root `/docs/` tree so GitHub and the docs site share one source of truth

## Stack

- Astro 7 (with `@astrojs/react` for marketing islands, `@astrojs/starlight` for docs)
- Tailwind 4 via `@tailwindcss/vite`
- Docs styling is hand-rolled: `src/styles/starlight.css` plus `Head`, `Header` and `ThemeSelect` overrides in `src/components/starlight/`, wired up in `astro.config.mjs`
- Fontsource for self-hosted fonts (Mona Sans, Inter, Space Mono, Mozilla Text), imported in `src/styles/tokens.css` and `src/styles/marketing.css`

## Commands

Run from this directory:

```bash
bun install
bun run dev          # http://localhost:4321
bun run build        # static output in ./dist
bun run preview      # serve the build locally
```

## Deploys

The site ships as a container image, not a hosted static-site service. `deploy/docker/marketing.Dockerfile` builds it and **must run with the repo root as its build context** — the docs loader reads `../docs`, so the Dockerfile copies both `web/` and the root `docs/` into the build. `.github/workflows/images-publish.yml` publishes the result as `ghcr.io/thunderbird/thunderbolt/thunderbolt-marketing`; the final stage is nginx-unprivileged listening on 8080 with `deploy/config/marketing-nginx.conf`, deployed by `deploy/k8s/templates/marketing.yaml`. All three surfaces (landing, blog, docs) are served from one origin at `thunderbolt.io` under subpaths.

## Content

- **New blog post:** add a markdown file under `src/content/blog/`. Frontmatter requires `title`, `description`, `date`, `author`; `tags`, `image`, `draft` are optional.
- **New doc:** add a markdown file under the repo-root `docs/` directory, then register its slug in `astro.config.mjs` under `starlight({ sidebar })` — a doc with no sidebar entry still builds, but nothing links to it. Slugs are `docs/<path-without-.md>`, and a `README.md` or `index.md` collapses to its directory's slug (`docs/architecture/README.md` → `docs/architecture`); see `computeSlug` in `src/loaders/repo-docs-loader.ts`.
