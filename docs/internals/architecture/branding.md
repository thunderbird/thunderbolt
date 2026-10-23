# Operator Branding

A deployment can rename the app and restyle it at runtime, without a rebuild: colors for every surface, shadows, fonts, logo, corner radius, letter spacing, the default theme and its legal and support links. This is an operator feature: one look per deployment, shared by every user. There is no per-user customization.

The operator-facing reference is [Branding in the configuration guide](../../self-hosting/configuration.md#branding). This page covers how the value travels and what is left to do.

## Format: shadcn's theme tokens

`cssVars` follows the shadcn theme format (`theme` / `light` / `dark`, kebab-case keys), which is what tweakcn and the shadcn theme gallery export. Our tokens descend from shadcn's, so the names line up almost one-to-one, and an operator can design a theme in tweakcn and paste its `cssVars` in. Thunderbolt adds `brand`, `brand-secondary`, `brand-foreground`, `border-strong`, `success` and `warning` on top.

Export keys we don't apply are accepted and stripped, so a paste never fails on them:

- **`spacing`** rescales every padding and fights the mobile touch-target sizes.
- **The precomputed `shadow-*` sizes** are regenerated from the six shadow parameters rather than trusted as raw CSS.

## Pipeline

1. **Contract and validation: `shared/branding.ts`.** The token lists, the `Branding` type, `parseBranding` (the one validator both ends run, collecting every problem), `isCssColor`, `radiusScaleFor` and `readableForeground`. It has no third-party imports, because the backend Docker image installs only `backend/node_modules`. That is also why the validator is hand-written rather than zod.
2. **Source: `BRANDING_JSON`.** `backend/src/config/settings.ts` parses it at boot; invalid JSON or values stop the API.
3. **Wire: `GET /config`.** `branding` passes through as validated and is omitted when unset. The admin dashboard will replace the env source with a stored value behind the same validator and the same key, so the client needs no change.
4. **Client.** Two modules, split so low-level code can read the name without pulling in the stylesheet machinery:
   - `src/lib/branding-selectors.ts` holds the read side: `selectBranding`, `selectAppName`, `useAppName` and `useBrandingLinks`. It imports only the config store and the shared contract, which keeps the agent defaults, model labels and MCP auth that read the app name free of import cycles.
   - `src/lib/branding.ts` holds the side effects: the stylesheet, fonts and logo.
   - `selectBranding` re-validates the cached config. These values become a stylesheet, and the backend a client talks to is a local setting, so anything invalid drops the whole branding.
   - `buildBrandingCss` emits overrides for the `index.css` tokens:
     - `html:not(.dark)` holds the light tokens and `html.dark` the dark ones. Specificity 0,1,1 beats both the `:root` tokens and the `.dark` block whatever the load order, and the two selectors never match together.
     - `html:root` holds `--radius-scale` and `letter-spacing`.
   - `installBranding` (called from `src/index.tsx` before the first render) applies the cached value and re-applies when `/config` replaces it. It also starts the font and logo downloads.
5. **Pre-paint: `index.html`.** Reads the cached `thunderbolt-config` for the default theme, the background and the title, so a returning visit paints without a flash. A first-ever visit paints the default look until `/config` answers.

### Precedence within a mode

From strongest to weakest:

1. Explicit tokens.
2. What Thunderbolt fills from them: brand from `primary`, foregrounds by contrast, `sidebar-primary` from `primary`.
3. Surfaces derived from `background`/`foreground`. These only kick in when a mode sets either.
4. The bundled defaults.

### Values are injection-safe by construction

Colors must match a hex pattern or a color function whose arguments are numbers, separators, `deg` or `none`. Lengths must be `px`/`rem`/`em` numbers. Nothing that can close a declaration survives, on either end.

### Derived surfaces

`color-mix(in oklch, …)` blends `background` toward `foreground`. That darkens in light mode and lightens in dark mode, so one set of ratios serves both. Cards lift toward white in light mode and toward the foreground in dark mode, as the hand-tuned palette does. Fed the default pair, the formulas land close to the defaults. They stay live CSS, so an explicit `foreground` change flows through.

### `primary` vs `brand`

In shadcn, `primary` is the action color that fills buttons. Ours fills tooltips and selected states, and the brand gradient fills buttons. A theme without `brand` therefore gets its `primary` as a solid brand, with `primary-foreground` as the brand text. This is how a pasted shadcn theme reproduces its own buttons. Our default sets `brand` itself, so it is unaffected.

### `input` in dark mode

In shadcn, `input` is an opaque field-border color, and dark fields fill with it at 30% (`dark:bg-input/30`). Our fields fill with `input` itself in dark mode (`dark:bg-input`, a translucent white by default). So a theme's dark `input` is applied at that 30%: at full strength, a white `input` turns every dark field white under white text. Light mode keeps shadcn's meaning, a border and switch-track color. The derived dark `input` is a translucent foreground tint for the same reason.

### Solid vs gradient

Every gradient surface sets a solid `bg-brand` under `background-image: var(--gradient-brand)`, and the gradient runs `--color-brand-2 → --color-brand`. With no `brand-secondary`, both stops are the same color and the gradient renders solid. Never set `--gradient-brand: none` instead: `src/search/highlight.tsx` and `src/components/ui/private-badge.tsx` use `bg-clip-text text-transparent`, and their text would vanish.

### Shadows

Tailwind v4 inlines `@theme` shadow values into the utilities at build time. So each `--shadow-*` in `index.css` is `var(--theme-shadow-*)`, and the real values live in `:root`. Branding overrides `--theme-shadow-*` with a scale generated by tweakcn's own formula from the six parameters, so an exported theme renders as it did in the editor. The glow tokens get a single shadow with no spread, because the detail panel feeds `--shadow-glow-strong` to `filter: drop-shadow()`. The indirection costs `shadow-<color>` tinting on these utilities; one call site used it.

### Radius

Every tier in `index.css`, desktop and mobile, is `calc(<rem> * var(--radius-scale))`. A shadcn `radius` length maps to the scale as value ÷ 0.625rem, shadcn's default. This keeps our concentric tiers and the mobile step-down; `rounded-full` is unaffected.

### Fonts

The four slots (`font-sans`, `font-heading`, `font-mono`, `font-serif`) become `--font-*` variables, which Tailwind's base `html` font and the `font-*` utilities read at runtime. Names are parsed into bare families, so no operator-written quote reaches the stylesheet; generics stay unquoted. Every list is followed by the system and CJK fallback chain, because brand fonts are mostly Latin-only.

The font files take a path designed around privacy and the Tauri content security policy:

1. **Download: `backend/src/branding/fonts.ts`.** At startup, in the background, `startServer` has the backend fetch each slot's first non-generic family from the Google Fonts css2 API. It runs there rather than in `createApp`, so apps built by tests never make the requests. It tries a variable weight range first, because Google rejects one on a static font, then the common static weights, then regular. It keeps the `latin` and `latin-ext` subsets and holds the files in memory under content-hashed names. Google sees the server, never a user.
2. **No lookalikes.** For a name Google doesn't host (Georgia, Times New Roman), Google answers 200 with a lookalike under `gstatic.com/l/font?kit=…`, labelled with the requested name. Only real `gstatic.com/s/<family>/` files are accepted. Anything else counts as "not hosted" and is left to the device, so the genuine font isn't replaced where it is installed.
3. **Serve: `GET /config/fonts/:file`.** The files are served `immutable`, and `/config` lists the faces as `brandingFonts`. Both sit under `/config`, so they share its app-version exemption.
4. **Load: `src/lib/branding-fonts.ts`.** The client fetches each file as bytes and registers it with the `FontFace` API. A content security policy governs font _loads_, not bytes the page already holds. The Tauri policy (`font-src 'self' data:`) can't name the backend, whose address is a user setting, so a URL source would be blocked. This was confirmed in Chromium and WebKit: bytes load, a URL from another origin is refused. Returning launches, offline ones included, come from the HTTP cache. Overlapping syncs share in-flight registrations; a failed download is forgotten so the next `/config` retries it.

Fonts are cosmetic, so a download failure is logged rather than fatal, and the app keeps its system fonts until the next restart.

### App name

`appName` replaces "Thunderbolt" wherever the text means _the app_. Text about the Thunderbolt product keeps the name: the CLI, Thunderbolt Pro, the desktop-app downloads, "Thunderbolt is open-source", the confidential enclave, and the reconciled default rows whose text is hashed. Where the name reaches:

- **Translated copy.** It passes as a `{appName}` placeholder. The catalogs were migrated by renaming each source id and its translations together, so no translation was lost; every translation kept "Thunderbolt" word for word. Module-scope descriptors that name the app became factories taking the name (`getSsoErrorMessage`, the revoke-device descriptions).
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

1. **Download: `backend/src/branding/logo.ts`.** `startServer` downloads `logo.light` and `logo.dark` from their https URLs, like the fonts. Only SVG, PNG, WebP and JPEG pass, capped at 512 KB, and light and dark are kept or dropped as a pair.
2. **Serve.** The files are content-addressed and served `immutable` at `GET /config/logo/:file`, and `/config` lists them as `brandingLogo`.
3. **Load: `src/lib/branding-logo.ts`.** The client fetches the bytes and renders a `data:` URL. The Tauri `img-src` allows `'self' asset: data:` and the production API host, and the backend's address is a user setting, so a URL source can't be named. `blob:` isn't allowed either.
4. **Display.** `AppLogo` shows a same-size blank while a configured logo loads, so the bolt never flashes in first, and falls back to the bolt if the download fails. On the web the light logo also becomes the favicon.
5. **Emails.** They link the operator's own URL when it's a PNG or JPEG, which email clients render (unlike SVG). The email palette takes the light branding colors converted to hex (`toHexColor`).

### Default theme

The per-device `theme` local setting is `null` until the user picks one. `ThemeProvider` resolves the user's choice, then `branding.defaultThemeMode`, then `'system'`. The pre-paint script follows the same order.

## Follow-ups

- **Remaining raw colors.** Status, error, warning and neutral colors now use tokens. A few stay on purpose: overlay scrims, labels over image thumbnails, white artifact frames and QR codes, vendor logos, and the white text on `bg-destructive` (the button, the window-close button, the ask widget's incorrect badge). The last ones wait on the `destructive-foreground` default below.
- **Presets and a playground.** Ship a few named themes (converted tweakcn presets, after checking their license, and never brand-imitating ones), plus a page that renders every primitive in both modes. That page doubles as the admin dashboard's preview.
- **Contrast warnings.** Have the backend log text/background pairs below 4.5:1 at boot. Warn, don't fail.
- **Disabled opacity and border width.** Neither is in shadcn's format. Disabled states already follow the tokens (`disabled:opacity-50`, and the primary button's `bg-secondary`). A border-width knob would apply to the UI primitives only, not every 1px line.
- **Focus ring default.** In light mode `--color-ring` equals the default `primary` by design. A theme sets `ring` explicitly or keeps ours.
- **Fonts from a folder.** Air-gapped deployments can't reach Google Fonts. Mounting font files plus a `@font-face` stylesheet (for example `BRANDING_FONTS_DIR`) could feed the same parser and route.
- **Fonts for other scripts.** Only Latin subsets are downloaded. Cyrillic, Greek and Vietnamese text falls back to system fonts.
- **Font sizing.** Text sizes and touch targets are tuned for system fonts. A wide or tall brand font may need `size-adjust` if it overflows tight controls.
- **Existing installs and the default theme.** Installs from before this change persisted `theme: 'system'`, which counts as a choice, so `defaultThemeMode` reaches new installs only.
- **macOS translucency.** On macOS desktop the sidebar is translucent over a native blur (`mac-vibrancy`). A branded `sidebar` color needs checking there.
- **Native shell.** The app icon, the OS-level app name, the splash screen, the tray tooltip and the device name are fixed at build time or set natively, and stay Thunderbolt.
- **Email logo from the served copy.** Emails link the operator's URL rather than the backend's downloaded copy, because the download state lives in `startServer`. An SVG logo leaves emails with the default mark; a PNG fallback could be rendered from it.
- **`destructive-foreground` default.** It's dark today, so the destructive button and the window-close button keep `text-white` instead of the token.
