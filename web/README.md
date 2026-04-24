# web

The public web surfaces for Thunderbolt, unified as a single Astro project:

- **Landing** — `/` (`src/pages/index.astro`), the marketing home
- **Announcement** — `/announcing-thunderbolt`, `/contact` (React islands wrapped in Astro pages)
- **Blog** — `/blog/*` (`src/content/blog/`)
- **Docs** — `/docs/*` (Starlight, content under `src/content/docs/docs/`)

## Stack

- Astro 6 (with `@astrojs/react` for marketing islands, `@astrojs/starlight` for docs)
- Tailwind 4 via `@tailwindcss/vite`
- `starlight-ion-theme` for the docs visual style
- Fontsource for self-hosted fonts (Mona Sans, Inter, Space Mono)

## Commands

Run from this directory:

```bash
bun install
bun run dev          # http://localhost:4321
bun run build        # static output in ./dist
bun run preview      # serve the build locally
```

## Deploys

`render.yaml` in this directory defines the Render static-site deploy. The project serves all three surfaces (landing, blog, docs) at `thunderbolt.io` with subpaths.

## Content

- **New blog post:** add a markdown file under `src/content/blog/`. Frontmatter requires `title`, `description`, `date`, `author`; `tags`, `image`, `draft` are optional.
- **New doc:** add a file under `src/content/docs/docs/<section>/<name>.md` and register its slug in `astro.config.mjs` under `starlight({ sidebar })`.
