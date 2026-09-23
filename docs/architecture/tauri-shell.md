# The Tauri Shell

Desktop and mobile builds run the same React bundle as the web app inside a Tauri 2 webview. The
Rust crate lives in [src-tauri/](../../src-tauri).

| File                                                                               | What lives there                                                          |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| [`src-tauri/src/lib.rs`](../../src-tauri/src/lib.rs)                               | App builder: plugin registration, invoke handlers, per-platform setup     |
| [`src-tauri/src/commands.rs`](../../src-tauri/src/commands.rs)                     | The five `invoke` commands the frontend calls                             |
| [`src-tauri/src/oauth_server.rs`](../../src-tauri/src/oauth_server.rs)             | One-shot loopback HTTP server for desktop OAuth/SSO redirects             |
| [`src-tauri/src/cli_installer.rs`](../../src-tauri/src/cli_installer.rs)           | Download, checksum-verify and install of the standalone `thunderbolt` CLI |
| [`src-tauri/src/platform_utils.rs`](../../src-tauri/src/platform_utils.rs)         | An inlined Tauri plugin whose commands Android overrides in Kotlin        |
| [`src-tauri/capabilities/default.json`](../../src-tauri/capabilities/default.json) | Permission manifest. A command the frontend can call must be listed here. |
| [`src-tauri/tauri.conf.json`](../../src-tauri/tauri.conf.json)                     | Base window, CSP, bundle, deep-link and updater config                    |

Thin by design: dock-icon flipping, the OAuth loopback port, the CLI installer, Android window
insets. No business logic, no native database plugin (shipped builds keep everything in PowerSync's
wa-sqlite in the webview), no native HTTP client the frontend can reach. `reqwest` compiles into
every build but only `cli_installer` uses it.

## The invoke commands

`lib.rs` registers exactly five ([`src-tauri/src/lib.rs:47`](../../src-tauri/src/lib.rs#L47)).
Everything else goes through an official plugin.

| Command                   | Platforms                                 | Purpose                                                                                                   | Frontend caller                                                                                                                                                                     |
| ------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `toggle_dock_icon`        | macOS (no-op else)                        | Switches activation policy between `Regular` and `Accessory`, so hiding to the tray removes the dock icon | [`src/lib/tray.tsx`](../../src/lib/tray.tsx)                                                                                                                                        |
| `capabilities`            | all                                       | Returns `{ native_fetch }`. See [`native_fetch`](#the-native_fetch-cargo-feature).                        | [`src/lib/platform.ts`](../../src/lib/platform.ts)                                                                                                                                  |
| `set_interface_style`     | iOS (no-op else)                          | Sets `overrideUserInterfaceStyle` on every window scene so keyboard and system UI follow the app theme    | [`src/lib/theme-provider.tsx`](../../src/lib/theme-provider.tsx)                                                                                                                    |
| `start_oauth_server`      | desktop (mobile signs in over deep links) | Binds the loopback listener and returns the port                                                          | [`oauth-loopback.ts`](../../src/lib/oauth-loopback.ts), [`sso-loopback.ts`](../../src/lib/sso-loopback.ts), [`mcp-oauth-loopback.ts`](../../src/lib/mcp-auth/mcp-oauth-loopback.ts) |
| `install_thunderbolt_cli` | macOS arm64, Linux                        | One-click install of the prebuilt CLI into `~/.local/bin`                                                 | [`src/lib/cli-install.ts`](../../src/lib/cli-install.ts)                                                                                                                            |

`set_interface_style` is iOS-only, not "mobile": Android keyboards follow the system dark-mode
setting and cannot be overridden per app.

### How the OAuth loopback server works

1. Binds `127.0.0.1` on one of three ports: `17421`, `17422`, `17423`.
2. Accepts a single connection and serves an "Authentication Complete" page.
3. Emits an `oauth-callback` event to the frontend and releases the port.

All three ports must be registered as redirect URIs in the provider's console; see
[self-hosting/configuration.md](../self-hosting/configuration.md).

- **Non-blocking accept loop with a 305-second deadline**
  ([`src-tauri/src/oauth_server.rs:62`](../../src-tauri/src/oauth_server.rs#L62)): five seconds past
  the frontend's five-minute timeout, so the frontend resolves first, and an abandoned flow frees
  the port instead of leaking a thread forever.
- **An unparseable connection still emits `oauth-callback`** with `error=invalid_request`, so a
  stray TCP probe surfaces immediately instead of stalling the UI for five minutes.
- **Why loopback:** the app has no `http(s)` origin a provider will redirect to. `bind_to_port`
  errors rather than picking a random port, since an unregistered redirect URI fails unreadably.
- **The first connection is unauthenticated**, the accepted risk for loopback OAuth (RFC 8252
  §8.3); PKCE blocks token theft because the verifier never leaves the frontend.

### What the CLI installer does

1. Derives download URLs from the running app's version and the naming scheme
   [`.github/workflows/cli-release.yml`](../../.github/workflows/cli-release.yml) publishes.
2. Fetches `SHA256SUMS` _first_, so a release predating the CLI pipeline 404s before any binary
   downloads.
3. Verifies the digest.
4. Writes the binary `0755` via a same-directory temp file plus atomic rename.

Failures are typed ([`CliInstallError`](../../src-tauri/src/cli_installer.rs#L41)); `unsupported`
and `notPublished` drive the UI's "build from source instead" fallback rather than a retry. Release
details: [RELEASE.md](../../RELEASE.md).

**The checksum catches transport corruption only.** Binary and manifest share a host and TLS
channel, so whoever could swap one could swap the other. There is no code signature, and
`strip_quarantine` drops the macOS quarantine xattr so Gatekeeper never assesses it. A detached
signature over the manifest is the known follow-up; the module header repeats this caveat, keep
both in sync.

### `platform-utils`: one plugin, two implementations

[`platform_utils.rs`](../../src-tauri/src/platform_utils.rs) declares an inlined plugin exposing
`get_android_insets` and `set_bar_color`.

- **Android** replaces the Rust bodies with `PlatformUtilsPlugin.kt`, registered via
  `register_android_plugin("net.thunderbird.thunderbolt", "PlatformUtilsPlugin")`, reading real
  `WindowInsetsCompat` values and driving `WindowInsetsControllerCompat`.
- **Desktop and iOS** fall through to the Rust bodies, deliberate no-ops (`None`, `Ok(())`).

Callers ([`use-safe-area-inset.ts`](../../src/hooks/use-safe-area-inset.ts),
[`set-android-bar-color.ts`](../../src/lib/set-android-bar-color.ts)) therefore invoke
unconditionally under Tauri and read `null`/no-op as "use the CSS `env()` defaults".

Command names are declared twice on the Rust side: `generate_handler!` and
[`build.rs`](../../src-tauri/build.rs), whose `InlinedPlugin` mints the allow-all-commands
`platform-utils:default` permission. Kotlin declares the camelCase counterparts (`getAndroidInsets`,
`setBarColor`) at exactly the package path `register_android_plugin` names; a mismatch is a runtime
`ClassNotFoundException: net.thunderbird.thunderbolt.PlatformUtilsPlugin`, not a build error.
Android specifics and the `gen/android` re-init trap:
[development/mobile-setup.md](../development/mobile-setup.md).

## Plugins and the capability manifest

| Scope                       | Plugins                                                                                                         |
| --------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Every target                | `process`, `fs`, `opener`, `os`, `deep-link`, `haptics`, `updater`, `store`, `platform-utils`                   |
| Desktop only                | `single-instance`. Its handler shows and focuses the existing `main` window, so a second copy raises the first. |
| `debug_assertions` only     | `devtools`                                                                                                      |
| `native_fetch` feature only | `tauri-plugin-http`. See [below](#the-native_fetch-cargo-feature).                                              |

Registration is not enough.
[`capabilities/default.json`](../../src-tauri/capabilities/default.json) is the allowlist the webview
is held to, scoped to `windows: ["main"]`. A command or window operation that works in a scratch
build and fails in the app is almost always missing an entry there.

- `remote.urls` permits `http://localhost:1420/*` because in dev Vite serves the frontend, which
  counts as remote content.
- The `http:default` URL allowlist only matters in builds that register the HTTP plugin.
- **`devtools` needs a crypto provider first.** Its `reqwest`/rustls stack panics on its first HTTPS
  call on iOS dev builds with no process-default provider, so
  [`src-tauri/src/lib.rs:55`](../../src-tauri/src/lib.rs#L55) installs
  `rustls::crypto::aws_lc_rs::default_provider()` _before_ registering it. Release builds exclude
  the plugin; the install is idempotent, and `cli_installer` does the same.

## Per-platform window and webview setup

| Platform       | What the shell does                                                                                                                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS          | Transparent window with native blur: `transparent`, `windowEffects: hudWindow`, `titleBarStyle: Overlay`, `hiddenTitle`, shifted `trafficLightPosition`, plus `macOSPrivateApi` (needed by the transparency) in the base config |
| Windows, Linux | Frameless: `set_decorations(false)` in the setup hook; the frontend paints minimize/maximize/close in the top-right                                                                                                             |
| iOS            | Forces `setOpaque(true)` on the WKWebView ([`src-tauri/src/lib.rs:111`](../../src-tauri/src/lib.rs#L111))                                                                                                                       |
| Linux          | Sets `JSC_useOMGJIT=false` before the webview is created                                                                                                                                                                        |
| Desktop (all)  | `tauri.conf.json` sets `visible: false` on `main`; [`src/app.tsx`](../../src/app.tsx) calls `getCurrentWindow().show()` after React mounts (any Tauri build), so no white flash ahead of the theme                              |

Declarative half: [`tauri.macos.conf.json`](../../src-tauri/tauri.macos.conf.json), merged over the
base config automatically by filename. Imperative half: `lib.rs` `setup` blocks.
`tauri.dev.conf.json` is a third overlay the `tauri:dev:*` scripts pass explicitly, changing only
product name and bundle identifier (`.dev`, so dev and prod coexist on a phone) and emptying
deep-link and updater config.

- **macOS transparency is macOS-only on purpose:** a transparent WebView2 window breaks compositing
  on Windows (dead scrollbars). [`src/index.tsx`](../../src/index.tsx) adds `mac-vibrancy` before
  first render so the body is transparent and only the sidebar reads as glass, the content pane
  staying opaque. `state: followsWindowActiveState` flattens the blur on an inactive window.
- **Frameless controls:** [`window-controls.tsx`](../../src/components/window-controls.tsx), gated
  on `isFramelessControlsPlatform()`. A fixed overlay, not a layout strip, so it cannot alter the
  `h-svh` content height; surfaces whose controls reach that corner reserve
  `--window-controls-width`. Close calls `close()`, which the tray's `onCloseRequested` intercepts
  to hide instead of quit. macOS uses `titleBarStyle: Overlay` instead: `decorations: false` would
  strip the native traffic lights.
- **iOS is forced opaque** even though `transparent` lives only in the macOS overlay, leaving it
  opaque already. A non-opaque webview lets the root view controller's `systemBackgroundColor` bleed
  through the status-bar and home-indicator safe areas, painting a white status bar over the light
  theme instead of `--color-background`.
- **`JSC_useOMGJIT=false`** disables only the OMG tier of WebKitGTK's optimizing WASM JIT (baseline
  stays on). That tier leaks native memory recompiling wa-sqlite's module, used here by PowerSync
  through `IDBBatchAtomicVFS`, eventually OOM-killing the web process. Set it before the webview is
  created, since WebKitGTK reads `JSC_*` at its own init. Tracked at
  [webkit.org bug 319572](https://bugs.webkit.org/show_bug.cgi?id=319572); remove when it lands.

## The `native_fetch` cargo feature

`tauri-plugin-http`, the native CORS-free HTTP path, is registered only under the `native_fetch`
Cargo feature ([`src-tauri/src/lib.rs:19`](../../src-tauri/src/lib.rs#L19)), which defaults off
([`src-tauri/Cargo.toml:18`](../../src-tauri/Cargo.toml#L18)) and no build in this repo passes. Every
shipped build reports `native_fetch: false`:

- The **"Use Native Fetch" dev toggle is inert**;
  [`dev-settings.tsx`](../../src/settings/dev-settings.tsx) disables the switch and says why.
- **`createProxyFetch`'s Tauri-direct branch is unreachable.** Its toggle-off path is also gated on
  the capability, since the plugin's JS shim throws "plugin http not found" in a build without it.
  BYO-key traffic uses the universal proxy (THU-467).
- [`src/lib/fetch.ts`](../../src/lib/fetch.ts) re-checks the capability rather than trusting a
  persisted `true` from an older build.

Locally: `bun run tauri build --features native_fetch`, plus the upstream in the `http:default`
allowlist. Whether the branch stays is undecided; treat it as opt-in, not as a second supported
transport.

## Platform detection in the frontend

[`src/lib/platform.ts`](../../src/lib/platform.ts) predicates that look interchangeable and are not.

| Predicate                       | Tauri desktop             | Tauri iOS/Android | Desktop browser  | Mobile browser   | Use it for                                          |
| ------------------------------- | ------------------------- | ----------------- | ---------------- | ---------------- | --------------------------------------------------- |
| `isTauri()`                     | ✅                        | ✅                | ❌               | ❌               | "is there a native shell at all"                    |
| `getPlatform()`                 | `macos`/`windows`/`linux` | `ios`/`android`   | `web`            | `web`            | the raw switch                                      |
| `isDesktop()`                   | ✅                        | ❌                | ❌               | ❌               | desktop OS _under Tauri_ (web reports `web`)        |
| `isMobile()`                    | ❌                        | ✅                | ❌               | ❌               | native mobile shell                                 |
| `isTauriDesktop()`              | ✅                        | ❌                | ❌               | ❌               | desktop-only chrome and layout forcing              |
| `isMacDesktop()`                | macOS only                | ❌                | ❌               | ❌               | traffic-light clearance, vibrancy, window theme     |
| `isFramelessControlsPlatform()` | Windows/Linux             | ❌                | ❌               | ❌               | frontend-painted caption buttons                    |
| `isWebMobilePlatform()`         | ❌                        | ❌                | ❌               | ✅               | mobile-web-only UI (install banners, viewport lock) |
| `isWebDesktopPlatform()`        | ❌                        | ❌                | ✅               | ❌               | "download the app" affordances                      |
| `isIosPlatform()`               | ❌                        | iOS only          | ❌               | iOS/iPadOS       | WebKit/iOS quirks regardless of shell               |
| `useIsMobile()`                 | ❌ (always)               | viewport < 768px  | viewport < 768px | viewport < 768px | layout decisions                                    |
| `useIsNativeMobile()`           | ❌                        | viewport < 768px  | ❌               | ❌               | safe areas and keyboard insets                      |

Two families. Tauri-native predicates read `@tauri-apps/plugin-os`, and `getPlatform()` returns
`'web'` unless `'isTauri' in window`, so all are false in any browser, phone included. `web*`
predicates mirror it: `getWebOsPlatform()` returns `'unknown'` whenever `isTauri()`. Neither family
says anything about the viewport.

- **`useIsMobile()` is false on Tauri desktop however narrow the window**
  ([`src/hooks/use-mobile.ts:18`](../../src/hooks/use-mobile.ts#L18)): `minWidth: 500` lets the
  window go well under the 768px breakpoint, which would otherwise flip the app to mobile layout.
  `src/index.tsx` adds a `force-desktop` class for the CSS half of the rule; keep them in step.
- **`isIosPlatform()` ORs the Tauri-native and UA paths**, what a WebKit-specific workaround (the
  Lockdown-Mode storage hint) needs and no other predicate covers. iPadOS 13+ wrinkle in
  `getWebOsPlatform`: iPads send a desktop "Macintosh" UA, so touch support tells them apart.
- **None of them throw without a DOM.** `getPlatform()` and `getWebOsPlatform()` guard `window` and
  `navigator`, so a bun test with no DOM gets the web/false answer. The hooks do need one:
  `useIsMobile` reads `window.matchMedia` through `useSyncExternalStore`.

### Capabilities and the database type

`getCapabilities()` is async because it must `invoke('capabilities')`, and is memoized per page via
[`memoize`](../../src/lib/memoize.ts). It resolves to `{ native_fetch: false }` off Tauri _and_ on
any invoke failure, so a build problem degrades to the proxy path rather than erroring.

`getDatabaseType()` unconditionally returns `'powersync'`
([`src/lib/platform.ts:272`](../../src/lib/platform.ts#L272)) and both callers
([`use-app-initialization.ts`](../../src/hooks/use-app-initialization.ts),
[`src/lib/fs.ts`](../../src/lib/fs.ts)) feed it straight into `getDatabasePath`, so that function's
`bun-sqlite` branch is dead. The `bun-sqlite` type survives for bun tests, which build a `Database`
at an explicit `:memory:` path ([`src/dal/test-utils.ts`](../../src/dal/test-utils.ts)) and never
call `getDatabasePath`. Do not hang runtime behaviour off the database type; it never varies by
platform.

## Artefacts that are not live configuration

- `src-tauri/.env.example`: `IMAP_*` variables and an `INPUT_FILE` for a feature that does not
  exist. Nothing in `src-tauri/src` or `Cargo.toml` mentions IMAP.
- `src-tauri/test-embeddings.js`: Tauri v1 `window.__TAURI__.tauri` API, invoking an `init_embedder`
  command the crate does not define.
- `dist-isolation` in `vite.config.ts`'s `server.fs.allow`, resolved against the repo root. No such
  directory exists and `tauri.conf.json` declares no isolation pattern.

## Related documents

- [development/mobile-setup.md](../development/mobile-setup.md): iOS/Android toolchains, committed
  `gen/` trees, hand-maintained native sources.
- [features/webview.md](../features/webview.md): embedded `WebView` sidebar, per-platform engine
  behaviour.
- [features/tauri-signing-keys.md](../features/tauri-signing-keys.md),
  [dev-tooling/local-cdn-for-app-update-testing.md](../dev-tooling/local-cdn-for-app-update-testing.md):
  updater signing, testing the update flow end to end.
- [RELEASE.md](../../RELEASE.md): desktop/mobile release workflows, CLI release pipeline.
