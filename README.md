# thunderbolt-site

Standalone static site for the Thunderbolt.io redesign, imported from a Claude
Design artifact (`Thunderbolt Site.dc.html`).

## Stack

Mirrors the Vite/Tailwind/React tooling from thunderbolt's `web/` project, scoped
to just this site:

- Astro 6 (`@astrojs/react` integration)
- Tailwind v4 via `@tailwindcss/vite`

The imported design lives in `public/` and is fully self-contained: `support.js`
(the design runtime) boots its own React 18 UMD build from a CDN and renders the
page client-side. Astro's role here is the dev server + static build.

## Commands

```bash
bun install
bun run dev      # http://localhost:4321
bun run build    # static output in ./dist
bun run preview  # serve the build locally
```

## Layout

- `public/index.html` — the imported design (rendered by `support.js`)
- `public/support.js`, `public/image-slot.js` — design runtime
- `public/assets/`, `public/screenshots/`, `public/uploads/` — design images

Some press/enterprise logos are referenced as absolute `https://www.thunderbolt.io/…`
URLs (part of the original design); they load from the live domain. Local copies
of these assets exist in `../thunderbolt/web/public/` if they ever need vendoring.

## Deploy (Render static site)

- **Build command:** `bun install && bun run build`
- **Publish directory:** `dist`
