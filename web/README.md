# web

The public web surfaces for Thunderbolt, unified as a single Astro project:

- **Landing** — `/` (`src/pages/index.astro`), the marketing home
- **Privacy** — `/privacy`, privacy choices and confidential inference
- **Enterprise** — `/enterprise`, the organization and self-hosting overview
- **Contact** — `/contact` (a React island wrapped in an Astro page). `/announcing-thunderbolt` is a redirect to `/blog/mozilla-introduces-thunderbolt`, configured in `redirects` in `astro.config.mjs`
- **Blog** — `/blog/*` (`src/content/blog/`)
- **Docs** — `/docs/*` (Starlight). The content is not in this directory: `src/loaders/repo-docs-loader.ts` walks the repo-root `/docs/` tree so GitHub and the docs site share one source of truth

## Stack

- Astro 7 (with `@astrojs/react` for marketing islands, `@astrojs/starlight` for docs)
- Tailwind 4 via `@tailwindcss/vite`
- Docs styling is hand-rolled: `src/styles/starlight.css` plus `Head`, `Header`, `PageTitle`, `PageSidebar`, `MobileMenuToggle`, and `ThemeSelect` overrides in `src/components/starlight/`, wired up in `astro.config.mjs`
- Blog and docs share Spark’s palette (`src/styles/spark-palette.css`), editorial styles (`src/styles/spark-editorial.css`), and navigation (`SparkHeader` and `spark-chrome.css`). Docs retain Starlight search and sidebar navigation. Blog posts retain their canonical Markdown content and use `BlogPost.astro` for the reading layout.
- Spark, blog, docs, enterprise, and contact share system-based light/dark mode through `src/components/site-theme/`. `ThemeProvider.astro` applies the OS palette before first paint and follows OS changes. Only development builds show a theme toggle and honor the saved `starlight-theme` preview preference; production ignores saved overrides. New themed layouts must include this provider, and colors belong in `spark-palette.css`.
- Spark’s product demos use `ProductDemo`, backed by `product-demos.ts`. H.264 videos live in `public/videos/marketing/`; WebP posters in `public/images/marketing/screenshots/`. Only the selected client and theme loads a video. Playback pauses outside the viewport or in a background tab, respects reduced motion, and offers a keyboard-accessible play/pause button. Posters use `<picture>` for production OS themes and CSS for development overrides.
- Fontsource for self-hosted fonts (Lora for marketing and blog headings, Mozilla Headline for the wordmark, Inter for body text and docs), imported in `src/styles/tokens.css`. The shared tokens mirror the app’s warm palette and amber-to-raspberry brand gradient

## Commands

Run from this directory:

```bash
bun install
bun run dev          # http://localhost:4321
bun run test         # isolated website tests
bun run test:coverage
bun run typecheck    # Astro types + TypeScript
bun run build        # static output in ./dist
bun run preview      # serve the build locally
```

## Spark design

Spark is the production homepage at `/`, with shared components in `src/components/marketing/spark/`. The old `/designs/spark` preview redirects to `/`; the alternate concepts and font explorer are excluded from the production site.

The shared header shows Privacy, Enterprise, and Docs directly when space permits. Links progressively move into More on narrower screens; Blog and Contact always live there. Add destinations to `primaryPages` or `morePages` in `spark-header.tsx`, with paired visibility rules in `spark-chrome.css` for any new primary link. Download and community destinations live in `src/data/website-product.ts`; public mobile store URLs are still pending.

## Deploys

The site ships as a container image, not a hosted static-site service. `deploy/docker/marketing.Dockerfile` builds it and **must run with the repo root as its build context** — the docs loader reads `../docs`, so the Dockerfile copies both `web/` and the root `docs/` into the build. `.github/workflows/images-publish.yml` publishes the result as `ghcr.io/thunderbird/thunderbolt/thunderbolt-marketing`; the final stage is nginx-unprivileged listening on 8080 with `deploy/config/marketing-nginx.conf`, deployed by `deploy/k8s/templates/marketing.yaml`. All surfaces (landing, enterprise, contact, blog, docs) are served from one origin at `thunderbolt.io` under subpaths.

## Content

- **New blog post:** add a markdown file under `src/content/blog/`. Frontmatter requires `title`, `description`, `date`, `author`; `tags`, `image`, `draft` are optional.
- **New doc:** add a markdown file under the repo-root `docs/` directory, then register its slug in `astro.config.mjs` under `starlight({ sidebar })` — a doc with no sidebar entry still builds, but nothing links to it. Slugs are `docs/<path-without-.md>`, and a `README.md` or `index.md` collapses to its directory's slug (`docs/using/README.md` → `docs/using`); see `computeSlug` in `src/loaders/repo-docs-loader.ts`. `docs/internals/` is the exception: the loader skips that whole tree (`unpublishedDirs`), so a page added there is contributor documentation and never reaches the site.

## Demo capture provenance

The selected desktop recordings are the Night School poster conversation (light) and the curious-niece conversation (dark), recorded continuously from the native macOS app with [Kottke’s Webb photo story](https://kottke.org/24/02/spectacular-jwst-photos-adorn-new-usps-stamps) opening in the side browser. Source imagery includes NASA/ESA/CSA/STScI photography reproduced on USPS stamps. The mobile pair is the rainy-day conversation (light) and neighborhood seed-sharing app (dark), recorded from the real responsive web app in a phone viewport, not a native iOS/Android build. Their genuine local Qwen replies predate the takes; the dark take ends with an unsent follow-up. The light reply retains its generated `[N]` marker.

The terminal demo is a 30 fps replay of an actual Thunderbolt CLI PTY session building and running a focus-planning tool, with idle waits shortened. Its gallery headings, border, and footer are cropped out; the website supplies the terminal chrome. All selected videos are silent and retain recorded frame timing within each kept segment. Desktop edits cut long waits between the response and opening the side browser and remove the small native recording control at the top left using localized pixel interpolation. The full desktop frame is preserved; a proportional corner mask matches the native window without cropping sidebar spacing or controls. Mobile edits shorten repeated reading holds. No prompts, replies, commands, or results are rewritten. Full review originals remain outside the repository.

## Refreshing product videos

Use [$thunder-demo-videos](../.agents/skills/thunder-demo-videos/SKILL.md) to capture a new feature or revise the existing demos. The skill includes a window-only macOS recorder, native terminal-window recording and genuine CLI PTY logs, and an FFmpeg editor with source hashes and cadence reports. The Claude skill path links to the same repository source.

`demo-edits.json` stores the current source-relative keep ranges, cosmetic cleanup, terminal crop, output paths, and poster timestamps. Run the skill's editor from a prepared Python environment:

```sh
python ../.agents/skills/thunder-demo-videos/scripts/demo.py edit demo-edits.json \
  --source-dir /absolute/path/to/product-demo-videos --output-dir public \
  --report /absolute/path/to/session/exports.json
```

The current source directory contains the `smooth/` GUI recordings and `cli-natural-02-focus.mp4`. Choose new source files and inspect their timelines when a feature changes; old timestamps are specific to the recorded session. The editor derives posters from the edited videos, so playback, fallback frames, and cleanup stay consistent. Update `product-demos.ts` if the dimensions, filenames, or story change.

## Contact form delivery

The contact form posts to the backend's public `POST /v1/contact` endpoint. It sends an internal notification through Resend; it does not subscribe visitors to a mailing list. Configure these **backend** environment variables:

- `CONTACT_EMAIL_TO`: the inbox that receives inquiries. There is no default; leaving it unset disables delivery and returns an unavailable response.
- `RESEND_API_KEY`: the existing transactional-email API key.
- `EMAIL_FROM`: a sender on a domain verified in your Resend account.

Visitors can supply only their contact details and message. The recipient and subject are fixed by the server. Requests are limited to three per hour per client IP, even when general application rate limiting is disabled. Configure `TRUSTED_PROXY` for the deployment's actual ingress/proxy so unrelated visitors do not share one limit; never trust arbitrary forwarded headers. A fixed single nginx/ALB hop uses `TRUSTED_PROXY=1`; multiple hops require the exact count and an origin reachable only through that fixed chain.

For Kubernetes, set `backend.env.trustedProxy` for your ingress and use `backend.email.contactTo`, `backend.email.from`, and `backend.email.resendApiKeyBase64`. The marketing hostname routes only the exact `/v1/contact` path to the backend; the rest remains static. Supply secrets through your normal deployment secret workflow, not committed values files.

Fargate routes the exact `/v1/contact` path on the marketing hostname to the backend. PR preview image builds set `PUBLIC_CONTACT_ENDPOINT` to that preview’s API URL; the preview backend already permits its marketing origin.

During `bun run dev`, Vite proxies `/v1/contact` to `http://127.0.0.1:8000`. Set `CONTACT_API_TARGET` to use another local backend. Static preview servers do not provide the API. On other hosting platforms, configure the same reverse-proxy route or set `PUBLIC_CONTACT_ENDPOINT` at build time to your backend URL and include the site's origin in backend CORS configuration. Only that public URL belongs in the website build; never expose a Resend key through a `PUBLIC_` variable.

The UI reports success only after Resend accepts the message. Delivery to the final inbox can still bounce or be filtered; monitor that through Resend. Automated tests mock the mail provider and do not send email.

## Desktop download metadata

The homepage and download page embed a stable release snapshot during the Astro build, so the download button does not wait for a network request. The build shares one GitHub lookup across both pages and `/downloads/release.json`; offline builds use `src/data/download-release.json` as a known-good fallback.

Browsers refresh from **`/downloads/release.json` on the website origin**, never directly from GitHub. The marketing nginx container caches the fixed public GitHub latest-release response for five minutes, coalesces concurrent cache misses, and refreshes expired entries in the background. Each marketing instance has its own cache. Stale metadata remains usable during upstream errors or rate limiting; a cold cache falls back to the build's static JSON file. Request headers and cookies from visitors are not forwarded upstream. No release webhook or website redeployment is needed for routine release updates.

Astro dev and static-only hosting serve the build snapshot at that URL. Other production hosts must provide the equivalent shared cache/reverse proxy to keep release metadata fresh between builds.

Run `bun run test:release-cache` in `web/` to exercise the real nginx cache against a local upstream fixture in Docker (cache sharing, background refresh, and cold/warm upstream outages). Website CI runs this check as well.
