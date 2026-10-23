# Operator Branding

A deployment can rename the app and restyle it at runtime, without a rebuild: colors for every surface, shadows, fonts, logo, corner radius, letter spacing, the default theme, its legal and support links, and the team named as the recipient of debug transcripts. This is an operator feature: one look per deployment, shared by every user. There is no per-user customization.

The operator-facing reference is [Branding in the configuration guide](../../self-hosting/configuration.md#branding). This page covers how the value travels and what is left to do.

## Format: shadcn's theme tokens

`cssVars` follows the shadcn theme format (`theme` / `light` / `dark`, kebab-case keys), which is what tweakcn and the shadcn theme gallery export. Our tokens descend from shadcn's, so the names line up almost one-to-one, and an operator can design a theme in tweakcn and paste its `cssVars` in. Thunderbolt adds `brand`, `brand-gradient-start`, `brand-foreground`, `border-strong`, `success` and `warning` on top.

Export keys we don't apply are accepted and stripped, so a paste never fails on them:

- **`spacing`** rescales every padding and fights the mobile touch-target sizes.
- **The `tracking-*` scale** is derived from `letter-spacing`, which is applied instead.
- **The precomputed `shadow-*` sizes** are regenerated from the six shadow parameters rather than trusted as raw CSS.

## Pipeline

1. **Contract and validation: `shared/branding.ts`.** The token lists, the `Branding` and `PublicBranding` types, the two validators, `isCssColor`, `radiusScaleFor` and `readableForeground`. Both validators share the per-field rules: `parseBranding` is strict and collects every problem, `parsePublicBranding` is lenient (see the client step). It has no third-party imports, because the backend Docker image installs only `backend/node_modules`. That is also why the validators are hand-written rather than zod.
2. **Source: `BRANDING`.** `backend/src/config/settings.ts` parses it at boot with `parseBranding`; invalid JSON or any invalid value stops the API.
3. **Assets: `backend/src/branding/assets.ts`.** `startServer` downloads the fonts and logos before it starts listening (see [Fonts](#fonts) and [Logo](#logo)).
4. **Wire: `GET /config`.** `branding` is the validated value with `logo` swapped for the manifest of downloaded files (`{ light: { file, type }, dark? }`) and a `fonts` list of the resolved faces added (`PublicBranding`). `fonts` and `logo` are omitted until their downloads land, and `branding` is omitted when unset. The files themselves are served from `GET /config/branding/:file`. Both sit under `/config`, so they share its app-version exemption. The admin dashboard will replace the env source with a stored value behind the same validator and the same key, so the client needs no change.
5. **Client.** Split so low-level code can read the name without pulling in the stylesheet machinery:
   - `src/lib/branding-selectors.ts` holds the read side: `selectBranding`, `selectAppName`, `useAppName`, `getAppName` (outside React), `useDebugTranscriptRecipient` and `useBrandingLinks`. It imports only the config store, leaf helpers and the shared contract, which keeps the agent defaults, model labels and MCP auth that read the app name free of import cycles.
   - `src/lib/branding.ts` holds the stylesheet and `installBranding`; `src/lib/branding-fonts.ts`, `src/lib/branding-logo.ts` (logos and the favicon) and `src/lib/branding-files.ts` (the shared file fetch) hold the downloads.
   - `selectBranding` re-validates the cached config with `parsePublicBranding`. These values become a stylesheet, hrefs and request paths, and the backend a client talks to is a local setting, so every value passes the same checks as on the backend. Unlike the backend, it is lenient: an unknown key or an invalid value is dropped on its own with a console warning, and the rest applies. A newer backend may add keys or accept values an older client doesn't know, and that must not cost the older client its whole theme.
   - `buildBrandingCss` emits overrides for the `index.css` tokens:
     - `html:not(.dark)` holds the light tokens and `html.dark` the dark ones. Specificity 0,1,1 beats both the `:root` tokens and the `.dark` block whatever the load order, and the two selectors never match together.
     - `html:root` holds `--radius-scale`, `letter-spacing` and the `--font-*` declarations.
   - `installBranding` (called from `src/index.tsx` before the first render) applies the cached value and re-applies when `/config` replaces it. It also starts the font and logo downloads.
6. **Pre-paint: `index.html`.** Reads the cached `thunderbolt-config` for the default theme, the background and the title, so a returning visit paints without a flash. A first-ever visit paints the default look until `/config` answers.

### Precedence within a mode

From strongest to weakest:

1. Explicit tokens.
2. What Thunderbolt fills from them: brand from `primary`, foregrounds by contrast, `sidebar-primary` from `primary`.
3. Surfaces derived from `background`/`foreground`. These only kick in when a mode sets either.
4. The bundled defaults.

### Values are injection-safe by construction

Colors must match a hex pattern or a color function whose arguments are numbers, separators, `deg` or `none`. Lengths must be `px`/`rem`/`em` numbers; only a bare zero may omit the unit, and it is normalized to `0px` because `calc(0 - 1px)` is invalid. `radius` takes only non-negative `px` or `rem`. Nothing that can close a declaration survives, on either end.

### Derived surfaces

`color-mix(in oklch, …)` blends `background` toward `foreground`. That darkens in light mode and lightens in dark mode, so one set of ratios serves both. Cards lift toward white in light mode and toward the foreground in dark mode, as the hand-tuned palette does. Fed the default pair, the formulas land close to the defaults. They stay live CSS, so an explicit `foreground` change flows through.

### `primary` vs `brand`

In shadcn, `primary` is the action color that fills buttons. Ours fills tooltips and selected states, and the brand gradient fills buttons. A theme without `brand` therefore gets its `primary` as a solid brand, with `primary-foreground` as the brand text. This is how a pasted shadcn theme reproduces its own buttons. Our default sets `brand` itself, so it is unaffected.

### `input` in dark mode

In shadcn, `input` is an opaque field-border color, and dark fields fill with it at 30% (`dark:bg-input/30`). Our fields fill with `input` itself in dark mode (`dark:bg-input`, a translucent white by default). So a theme's dark `input` is applied at that 30%: at full strength, a white `input` turns every dark field white under white text. Light mode keeps shadcn's meaning, a border and switch-track color. The derived dark `input` is a translucent foreground tint for the same reason.

### Solid vs gradient

Every gradient surface sets a solid `bg-brand` under `background-image: var(--gradient-brand)`, and the gradient runs `--color-brand-2 → --color-brand`. With no `brand-gradient-start` (which maps to `--color-brand-2`), both stops are the same color and the gradient renders solid. Never set `--gradient-brand: none` instead: `src/search/highlight.tsx` and `src/components/ui/private-badge.tsx` use `bg-clip-text text-transparent`, and their text would vanish.

### Shadows

Tailwind v4 inlines `@theme` shadow values into the utilities at build time. So each `--shadow-*` in `index.css` is `var(--theme-shadow-*)`, and the real values live in `:root`. Branding overrides `--theme-shadow-*` with a scale generated by tweakcn's own formula from the six parameters, so an exported theme renders as it did in the editor. The glow tokens get a single shadow with no spread, because the detail panel feeds `--shadow-glow-strong` to `filter: drop-shadow()`. The indirection costs `shadow-<color>` tinting on these utilities; one call site used it.

### Radius

Every tier in `index.css`, desktop and mobile, is `calc(<rem> * var(--radius-scale))`. A shadcn `radius` length maps to the scale as value ÷ 0.625rem, shadcn's default. This keeps our concentric tiers and the mobile step-down; `rounded-full` is unaffected.

### Fonts

The four slots (`font-sans`, `font-heading`, `font-mono`, `font-serif`) become `--font-*` variables, which Tailwind's base `html` font and the `font-*` utilities read at runtime. Names are parsed into bare families, so no operator-written quote reaches the stylesheet; generics stay unquoted. Every list is followed by the system and CJK fallback chain, because brand fonts are mostly Latin-only.

The font files take a path designed around privacy and the Tauri content security policy:

1. **Download: `backend/src/branding/fonts.ts`.** At startup `startServer` has the backend fetch each slot's first non-generic family from the Google Fonts css2 API. It runs there rather than in `createApp`, so apps built by tests never make the requests. It tries a variable weight range first, because Google rejects one on a static font, then the common static weights, then regular. It keeps the `latin` and `latin-ext` subsets and holds the files in memory under content-hashed names. Google sees the server, never a user.
2. **Not hosted vs down.** Google answers 400 for a family it doesn't host (and for axes a family lacks), so after every axis query returns 400 the family counts as "not hosted" and is assumed installed on devices. Any other non-OK status is an outage, and the download is retried. For some names Google doesn't host (Georgia, Times New Roman), it answers 200 with a lookalike under `gstatic.com/l/font?kit=…`, labeled with the requested name. Only real `gstatic.com/s/<family>/` files are accepted, so the lookalike also counts as "not hosted" and the genuine font isn't replaced where it is installed.
3. **Serve: `GET /config/branding/:file`.** The files are served `immutable`, and `/config` lists the faces as `branding.fonts`.
4. **Load: `src/lib/branding-fonts.ts`.** The client fetches each file as bytes and registers it with the `FontFace` API. A content security policy governs font _loads_, not bytes the page already holds. The Tauri policy (`font-src 'self' data:`) can't name the backend, whose address is a user setting, so a URL source would be blocked. This was confirmed in Chromium and WebKit: bytes load, a URL from another origin is refused. Returning launches, offline ones included, come from the HTTP cache. Overlapping syncs share in-flight registrations; a failed download is forgotten so the next `/config` retries it.

Fonts are cosmetic, so a download failure is logged rather than fatal, and the app shows its system fonts until a retry succeeds (see [Downloads and retries](#downloads-and-retries)).

### App name

`appName` replaces "Thunderbolt" wherever the text means _the app_. Text about the Thunderbolt product keeps the name: the CLI, Thunderbolt Pro, the desktop-app downloads, "Thunderbolt is open-source", the confidential enclave, and the reconciled default rows whose text is hashed. Where the name reaches:

- **Translated copy.** It passes as a `{appName}` placeholder. The catalogs were migrated by renaming each source id and its translations together, so no translation was lost: each translation had "Thunderbolt" verbatim, so it was swapped for `{appName}` mechanically. Module-scope descriptors that name the app became factories taking the name (`getSsoErrorMessage`, the revoke-device descriptions).
- **The built-in agent.** `builtInAgent.name` is a getter reading the config store. Lists, pickers and session fallbacks all hold the same object, so every reader sees the current name without being threaded a hook. Only the agent's id is ever persisted.
- **Third-party surfaces.** The MCP OAuth `client_name` on a server's consent screen, which only new registrations pick up. The Mini App `hostName`.
- **Backend.**
  - Email copy, through `emailAppName()` in `backend/src/emails/email-layout.tsx`.
  - The passkey Relying Party name, through `getPasskeyRpName`: `PASSKEY_RP_NAME`, else `appName`.
  - The SSO desktop error page title, HTML-escaped.
- **Not renamed.** The native shell, meaning the app icon, the OS app name, the tray tooltip and `getDeviceDisplayName`. The device name also travels in the `X-Device-Name` header, where a non-Latin name would make `fetch` throw.

### Links

`links.privacyPolicy`, `termsOfService` and `support` replace the defaults in `src/lib/constants.ts` through `useBrandingLinks`. They become `href`s, so only http(s) passes, plus `mailto:` for `support`. No `javascript:` or `data:` link can reach the page.

### Logo

1. **Download: `backend/src/branding/logo.ts`.** `startServer` downloads `logo.light` and `logo.dark` from their https URLs, like the fonts. Only SVG, PNG, WebP and JPEG pass, capped at 512 KB, enforced from `Content-Length` when sent, else while streaming. Light and dark download independently: a dark logo that fails falls back to the light one rather than discarding it.
2. **Serve.** The files are content-addressed and served `immutable` at `GET /config/branding/:file`, and `/config` lists them as `branding.logo`. The route sends `Content-Security-Policy: sandbox`, `X-Content-Type-Options: nosniff` and `Content-Disposition: attachment`, so an SVG opened directly from the API origin (on single-origin deployments, the app's origin) can't run script, plus `Cross-Origin-Resource-Policy: cross-origin` so the app can fetch it from another origin.
3. **Load: `src/lib/branding-logo.ts`.** The client fetches the bytes and renders a `data:` URL. The Tauri `img-src` allows `'self' asset: data:` and the production API host, and the backend's address is a user setting, so a URL source can't be named. `blob:` isn't allowed either.
4. **Display.** `AppLogo` shows a same-size blank while a configured logo loads, so the bolt never flashes in first, and falls back to the bolt if the download fails. On the web the light logo also becomes the favicon.
5. **Emails.** With an operator logo set, emails link `GET /config/branding/email-logo` on the backend (the origin of `BETTER_AUTH_URL`), never the operator's logo host, so opening an email tells that host nothing. The route serves the downloaded light logo when it is PNG or JPEG, which email clients render (unlike SVG and WebP), and otherwise redirects to the bundled `${APP_URL}/email-logo.png`. It is cached for an hour rather than `immutable`, because the template names it before the download lands. The email palette takes the light branding colors converted to hex (`toHexColor`), each surface with its text as a pair (page, card, button) that is branded or default together: the button and its text come from `resolveBrandFill` in `shared/branding.ts`, the same helper the app uses: `brand`, else `primary`, with `brand-foreground` as text (or `primary-foreground` when the theme has no `brand`), else whichever of the theme's off-white and ink reads better. Links take the button color.

### Downloads and retries

`createBrandingAssets` runs each font family and each logo (light, dark) as its own download, through the SSRF-safe `createSafeFetch` with `httpsOnly`: every redirect hop is validated, so a redirect can neither reach a private address nor drop to plain http. `startServer` waits for the first attempts before it listens, capped at 15 seconds (`brandingStartupWaitMs`), because a client fetches `/config` once per launch and caches it: a pod joining a rolling deploy must serve fonts and logo from its first `/config`. If the cap runs out, the server starts anyway and logs a warning, and a download still running lands later.

A failed download is logged without holding back the others. One that can clear up (a network error, a timeout, a 5xx, 408 or 429) is retried after 30 seconds, then doubling up to 15 minutes, until it succeeds, so a pod that boots while Google or the logo host is down brands itself once the host is back. One no retry can fix (any other 4xx, a wrong type, an empty or oversized file, a redirect loop, a URL the SSRF guard refuses) is logged once as an error and not retried (`isRetryable` in `backend/src/branding/download.ts`). Anything Google Fonts serves is the exception: the stylesheet and the file URLs in it come from Google rather than `BRANDING`, so even a final 4xx or an oversized response is retried, and the retry fetches the stylesheet afresh. Logs name the logo host only, never the full URL, and carry the attempt number.

Every process downloads on its own, so behind a load balancer two of them can briefly disagree: one lists a file in `/config` that another, still retrying, answers 404 for. The client then shows the default font or logo and picks the file up on its next launch, when it fetches `/config` again.

### Transcript recipient

`debugTranscriptRecipient` is who the debug-transcript share dialog says receives the transcript, as "the {name} team". It defaults to Thunderbolt rather than `appName`, because the default intake at `DEBUG_TRANSCRIPT_UPSTREAM_URL` is Thunderbolt's (`resolveDebugTranscriptRecipient`, read on the client through `useDebugTranscriptRecipient`).

### Default theme

The per-device `theme` local setting is `null` until the user picks one. `ThemeProvider` resolves the user's choice, then `branding.defaultThemeMode`, then `'system'`. The pre-paint script follows the same order. Installs from before branding persisted `theme: 'system'` as their default, which would count as a choice, so the local settings store migrates a stored `'system'` to `null` once and `defaultThemeMode` reaches existing installs too.

## Follow-ups

- **Remaining raw colors.** Status, error, warning and neutral colors now use tokens. A few stay on purpose: overlay scrims, labels over image thumbnails, white artifact frames and QR codes, vendor logos, and the white text on `bg-destructive` (the button, the window-close button, the ask widget's incorrect badge). The last ones wait on the `destructive-foreground` default below.
- **Presets and a playground.** Ship a few named themes (converted tweakcn presets, after checking their license, and never brand-imitating ones), plus a page that renders every primitive in both modes. That page doubles as the admin dashboard's preview.
- **Contrast warnings.** Have the backend log text/background pairs below 4.5:1 at boot. Warn, don't fail.
- **Disabled opacity and border width.** Neither is in shadcn's format. Disabled states already follow the tokens (`disabled:opacity-50`, and the primary button's `bg-secondary`). A border-width knob would apply to the UI primitives only, not every 1px line.
- **Focus ring default.** In light mode `--color-ring` equals the default `primary` by design. A theme sets `ring` explicitly or keeps ours.
- **Fonts from a folder.** Air-gapped deployments can't reach Google Fonts. Mounting font files plus a `@font-face` stylesheet (for example `BRANDING_FONTS_DIR`) could feed the same parser and route.
- **Fonts for other scripts.** Only Latin subsets are downloaded. Cyrillic, Greek and Vietnamese text falls back to system fonts.
- **Font sizing.** Text sizes and touch targets are tuned for system fonts. A wide or tall brand font may need `size-adjust` if it overflows tight controls.
- **macOS translucency.** On macOS desktop the sidebar is translucent over a native blur (`mac-vibrancy`). A branded `sidebar` color needs checking there.
- **Native shell.** The app icon, the OS-level app name, the splash screen, the tray tooltip and the device name are fixed at build time or set natively, and stay Thunderbolt.
- **SVG logos in email.** An SVG or WebP logo leaves emails with the default mark; a PNG could be rendered from it.
- **`destructive-foreground` default.** It's dark today, so the destructive button and the window-close button keep `text-white` instead of the token.
