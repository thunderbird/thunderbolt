# The Tauri Shell

Desktop and mobile builds run the same React bundle as the web app inside a Tauri 2 webview. The
Rust crate in [src-tauri/](../../src-tauri) is deliberately thin: it exists only for the things a
webview cannot do itself — flipping the macOS dock icon, binding a loopback port for OAuth,
installing the prebuilt CLI binary, reading Android window insets. There is no business logic in
Rust, no native database plugin (shipped builds keep everything in PowerSync's wa-sqlite inside the
webview), and no native HTTP client the frontend can reach. The one Rust-side HTTP client —
`reqwest`, in `cli_installer` — is compiled into every build but used only by the CLI installer.

Because the shell is small, most of what bites contributors is not code but _per-platform setup_:
a handful of window and webview workarounds, a Cargo feature that compiles a whole fetch path out of
every build, and a set of frontend platform predicates that answer subtly different questions.

| File                                                                               | What lives there                                                              |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [`src-tauri/src/lib.rs`](../../src-tauri/src/lib.rs)                               | The app builder: plugin registration, invoke handlers, per-platform setup     |
| [`src-tauri/src/commands.rs`](../../src-tauri/src/commands.rs)                     | The five `invoke` commands the frontend calls                                 |
| [`src-tauri/src/oauth_server.rs`](../../src-tauri/src/oauth_server.rs)             | One-shot loopback HTTP server for desktop OAuth/SSO redirects                 |
| [`src-tauri/src/cli_installer.rs`](../../src-tauri/src/cli_installer.rs)           | Download + checksum-verify + install of the standalone `thunderbolt` CLI      |
| [`src-tauri/src/platform_utils.rs`](../../src-tauri/src/platform_utils.rs)         | An inlined Tauri plugin whose commands Android overrides in Kotlin            |
| [`src-tauri/capabilities/default.json`](../../src-tauri/capabilities/default.json) | The permission manifest — a command the frontend can call must be listed here |
| [`src-tauri/tauri.conf.json`](../../src-tauri/tauri.conf.json)                     | Base window, CSP, bundle, deep-link and updater config                        |

## The invoke commands

`lib.rs` registers exactly five commands ([`src-tauri/src/lib.rs:47`](../../src-tauri/src/lib.rs#L47)).
Everything else the frontend needs from the native side goes through an official plugin.

| Command                   | Platforms                                 | Purpose                                                                                                           | Frontend caller                                                                                                                                                                     |
| ------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `toggle_dock_icon`        | macOS (no-op else)                        | Switches the activation policy between `Regular` and `Accessory` so hiding to the tray also removes the dock icon | [`src/lib/tray.tsx`](../../src/lib/tray.tsx)                                                                                                                                        |
| `capabilities`            | all                                       | Returns `{ native_fetch }` for the current build — see [`native_fetch`](#the-native_fetch-cargo-feature)          | [`src/lib/platform.ts`](../../src/lib/platform.ts)                                                                                                                                  |
| `set_interface_style`     | iOS (no-op else)                          | Sets `overrideUserInterfaceStyle` on every window scene so the keyboard and system UI follow the app theme        | [`src/lib/theme-provider.tsx`](../../src/lib/theme-provider.tsx)                                                                                                                    |
| `start_oauth_server`      | desktop (mobile signs in over deep links) | Binds the loopback listener and returns the port                                                                  | [`oauth-loopback.ts`](../../src/lib/oauth-loopback.ts), [`sso-loopback.ts`](../../src/lib/sso-loopback.ts), [`mcp-oauth-loopback.ts`](../../src/lib/mcp-auth/mcp-oauth-loopback.ts) |
| `install_thunderbolt_cli` | macOS arm64, Linux                        | One-click install of the prebuilt CLI into `~/.local/bin`                                                         | [`src/lib/cli-install.ts`](../../src/lib/cli-install.ts)                                                                                                                            |

Android keyboards follow the system dark-mode setting and cannot be overridden per app, which is why
`set_interface_style` is iOS-only rather than "mobile".

### The OAuth loopback server

Desktop OAuth and SSO cannot use the web redirect — the app is not served from an `http(s)` origin
a provider will redirect to. Instead the Rust server binds `127.0.0.1` on one of three ports — `17421`, `17422`, `17423` — accepts a
single connection, serves an "Authentication Complete" page, emits an `oauth-callback` event to the
frontend, and releases the port. All three ports must be registered as redirect URIs in the
provider's console; `bind_to_port` errors rather than falling back to a random port, because a
provider rejects an unregistered redirect URI and the resulting failure is much harder to read. See
[self-hosting/configuration.md](../self-hosting/configuration.md) for the provider-side setup.

Two details are load-bearing. The accept loop is non-blocking with a 305-second deadline
([`src-tauri/src/oauth_server.rs:62`](../../src-tauri/src/oauth_server.rs#L62)) — five seconds longer than the
frontend's five-minute timeout, so the frontend resolves first, but short enough that an abandoned
flow releases the port instead of leaking a thread forever. And an unparseable connection still
emits `oauth-callback`, carrying an `error=invalid_request` query, so a stray TCP probe surfaces
immediately instead of stalling the UI for five minutes.

The server accepts the first connection on the port without authenticating the caller. That is the
accepted risk for every loopback OAuth flow (RFC 8252 §8.3): PKCE is what prevents token theft,
since the code verifier never leaves the frontend.

### The CLI installer

`install_thunderbolt_cli` derives its download URLs from the running app's own version and the
naming scheme [`.github/workflows/cli-release.yml`](../../.github/workflows/cli-release.yml) publishes, fetches `SHA256SUMS` _first_ (so a release predating the
CLI pipeline 404s before any binary is downloaded), verifies the digest, then writes the binary
`0755` via a same-directory temp file plus atomic rename. Failures are typed
([`CliInstallError`](../../src-tauri/src/cli_installer.rs#L41)); `unsupported` and `notPublished` are
the two that drive the UI's "build from source instead" fallback rather than a retry.

Be precise about what the checksum buys: the binary and the manifest come from the same host over
the same TLS channel, so the digest catches transport corruption only. Whoever could swap the binary
could swap its recorded digest too, there is no code signature, and on macOS `strip_quarantine`
removes the quarantine xattr so Gatekeeper never assesses the unsigned binary. A detached signature
over the manifest is the known follow-up. The module header records the same caveat; keep the two in
sync. Release-side details are in [RELEASE.md](../../RELEASE.md).

### `platform-utils`: one plugin, two implementations

[`platform_utils.rs`](../../src-tauri/src/platform_utils.rs) declares an inlined plugin exposing
`get_android_insets` and `set_bar_color`. The Rust bodies are deliberate no-ops (`None` and `Ok(())`)
— on Android they are replaced by `PlatformUtilsPlugin.kt`, registered via
`register_android_plugin("net.thunderbird.thunderbolt", "PlatformUtilsPlugin")`, which reads real
`WindowInsetsCompat` values and drives `WindowInsetsControllerCompat`. Desktop and iOS fall through
to the Rust fallbacks, so callers such as
[`use-safe-area-inset.ts`](../../src/hooks/use-safe-area-inset.ts) and
[`set-android-bar-color.ts`](../../src/lib/set-android-bar-color.ts) can invoke unconditionally under
Tauri and let the `null`/no-op result mean "use the CSS `env()` defaults".

The command names are declared twice: in the Rust `generate_handler!` and again in
[`build.rs`](../../src-tauri/build.rs), whose `InlinedPlugin` lists them and mints the
allow-all-commands default permission the manifest refers to as `platform-utils:default`. The Kotlin
side declares their camelCase counterparts (`getAndroidInsets`, `setBarColor`) and has to sit at
exactly the package path `register_android_plugin` names; a mismatch surfaces at runtime as
`ClassNotFoundException: net.thunderbird.thunderbolt.PlatformUtilsPlugin`, not as a build error — see
[development/mobile-setup.md](../development/mobile-setup.md) for the Android specifics and the
`gen/android` re-init trap.

## Plugins and the capability manifest

`lib.rs` registers `process`, `fs`, `opener`, `os`, `deep-link`, `haptics`, `updater`, `store` and
`platform-utils` on every target, plus `single-instance` on desktop only (its handler shows and
focuses the existing `main` window, so launching a second copy raises the first) and
`devtools` under `debug_assertions` only.

Registration alone is not enough: [`capabilities/default.json`](../../src-tauri/capabilities/default.json)
is the allowlist the webview is actually held to, and it is scoped to `windows: ["main"]`. A new
command or window operation that works in a scratch build and fails in the app is almost always a
missing entry there. Two entries are easy to misread — `remote.urls` permits
`http://localhost:1420/*` because in dev the frontend is served by Vite and therefore counts as
remote content, and the `http:default` URL allowlist only matters in builds that register the HTTP
plugin at all (below).

`tauri-plugin-devtools` is debug-only, and it pulls in a `reqwest`/rustls stack that panics on its
first HTTPS call on iOS dev builds when no process-default crypto provider is installed. That is why
[`src-tauri/src/lib.rs:55`](../../src-tauri/src/lib.rs#L55) installs
`rustls::crypto::aws_lc_rs::default_provider()` _before_ registering the plugin. Release builds
exclude the plugin and are unaffected; the install is idempotent, and `cli_installer` does the same
before its own request.

## Per-platform window and webview setup

Tauri merges `tauri.<platform>.conf.json` over the base config automatically, so the declarative
half of this lives in [`tauri.macos.conf.json`](../../src-tauri/tauri.macos.conf.json) and the
imperative half in `lib.rs` `setup` blocks. `tauri.dev.conf.json` is a third overlay passed
explicitly by the `tauri:dev:*` scripts; it only changes the product name, the bundle identifier
(`.dev`, so dev and prod builds coexist on a phone) and empties the deep-link and updater config.

**macOS — transparent window with a native blur.** The macOS overlay sets `transparent`,
`windowEffects: hudWindow`, `titleBarStyle: Overlay`, `hiddenTitle` and a shifted
`trafficLightPosition`; `macOSPrivateApi`, which the transparency needs, is enabled in the base
config as well. The frontend cooperates: [`src/index.tsx`](../../src/index.tsx) adds a `mac-vibrancy` class before first render so
the body is transparent and only the sidebar reads as glass, while the main content pane stays opaque.
`state: followsWindowActiveState` flattens the blur on an inactive window, as native apps do. This is
scoped to macOS on purpose — a transparent WebView2 window breaks compositing on Windows (dead
scrollbars).

**Windows and Linux — frameless with frontend-painted controls.** The setup hook calls
`set_decorations(false)`, and [`window-controls.tsx`](../../src/components/window-controls.tsx)
paints minimize/maximize/close in the top-right, gated on `isFramelessControlsPlatform()`. It is a
fixed overlay rather than a layout strip so it cannot alter the `h-svh` content height; surfaces
whose own controls reach that corner reserve `--window-controls-width`. Close deliberately calls
`close()`, which the tray's `onCloseRequested` handler intercepts to hide instead of quit. macOS
takes the other route (`titleBarStyle: Overlay`) because `decorations: false` there would strip the
native traffic lights.

**iOS — forced-opaque WKWebView.** `transparent` lives only in the macOS overlay, so the iOS webview
is already opaque; [`src-tauri/src/lib.rs:111`](../../src-tauri/src/lib.rs#L111) forces
`setOpaque(true)` anyway. A non-opaque webview lets the root view controller's `systemBackgroundColor`
bleed through the status-bar and home-indicator safe areas, which renders a white status bar over the
light theme instead of the themed `--color-background`.

**Linux — `JSC_useOMGJIT=false`.** WebKitGTK's optimizing WASM JIT tier leaks native memory when it
repeatedly recompiles wa-sqlite's module, which PowerSync uses through `IDBBatchAtomicVFS` on this
platform, eventually OOM-killing the web process. Disabling just the OMG tier (baseline JIT stays on)
avoids it. The variable must be set before the webview is created because WebKitGTK reads `JSC_*` at
its own init. Tracked upstream at [webkit.org bug 319572](https://bugs.webkit.org/show_bug.cgi?id=319572);
remove it when that lands.

**Desktop — the window starts hidden.** `tauri.conf.json` sets `visible: false` on the `main`
window, and [`src/app.tsx`](../../src/app.tsx) calls `getCurrentWindow().show()` after React mounts
(on any Tauri build), so the webview's default white background never flashes ahead of the theme.

## The `native_fetch` cargo feature

`tauri-plugin-http` — the native, CORS-free HTTP path — is registered only under the `native_fetch`
Cargo feature ([`src-tauri/src/lib.rs:19`](../../src-tauri/src/lib.rs#L19)), which defaults to off
([`src-tauri/Cargo.toml:18`](../../src-tauri/Cargo.toml#L18)) and is passed by no build in this repo.
Every shipped build therefore reports `native_fetch: false`, and the consequences are worth knowing
before you debug around them:

- The **"Use Native Fetch" dev toggle is inert** — [`dev-settings.tsx`](../../src/settings/dev-settings.tsx)
  disables the switch when the capability is false and explains why in a tooltip.
- **`createProxyFetch`'s Tauri-direct branch is unreachable.** The toggle-off path is additionally
  gated on the capability, because invoking the plugin's JS shim in a build without it throws
  "plugin http not found". BYO-key traffic goes through the universal proxy instead — the intended
  path (THU-467).
- [`src/lib/fetch.ts`](../../src/lib/fetch.ts) re-checks the capability rather than trusting a
  persisted `true` from an older build.

To exercise the path locally, build with the feature (`bun run tauri build --features native_fetch`) and
add the upstream to the `http:default` allowlist in the capability manifest. Whether the branch stays
is an open question; treat it as opt-in, not as a second supported transport.

## Platform detection in the frontend

[`src/lib/platform.ts`](../../src/lib/platform.ts) exposes several predicates that look
interchangeable and are not. They split along one line: the Tauri-native predicates read
`@tauri-apps/plugin-os`, and `getPlatform()` returns `'web'` unless `'isTauri' in window` — so every
one of them is false in a browser, including a phone browser. The `web*` predicates are the mirror
image: `getWebOsPlatform()` returns `'unknown'` whenever `isTauri()`, so they are false in the app.
Neither family says anything about the viewport.

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

Three of these deserve their reasons written down:

- **`useIsMobile()` is false on Tauri desktop however narrow the window**
  ([`src/hooks/use-mobile.ts:18`](../../src/hooks/use-mobile.ts#L18)). The window can be resized well
  below the 768px breakpoint (`minWidth: 500` in `tauri.conf.json`), so without the override a narrow
  window would flip the whole app into the mobile layout. `src/index.tsx` adds a `force-desktop` class
  for the CSS half of the same rule; the hook is the JS half. Keep them in step.
- **`isIosPlatform()` exists because no other predicate covers iOS on its own** — it ORs the
  Tauri-native and UA paths, which is what a WebKit-specific workaround (such as the Lockdown-Mode
  storage hint) actually needs. Note the iPadOS 13+ wrinkle inside `getWebOsPlatform`: iPads report a
  desktop "Macintosh" UA, so touch support is what distinguishes them.
- **None of them throw without a DOM.** They all resolve through `getPlatform()` or
  `getWebOsPlatform()`, which guard `window` and `navigator` respectively, so a bun test with no DOM
  gets the web/false answer. The hooks do need a DOM: `useIsMobile` reads `window.matchMedia` through
  `useSyncExternalStore`.

### Capabilities and the database type

`getCapabilities()` is async because it has to `invoke('capabilities')`, and it is memoized for the
lifetime of the page via [`memoize`](../../src/lib/memoize.ts). It resolves to
`{ native_fetch: false }` off Tauri _and_ on any invoke failure, which means a build problem
degrades to the proxy path rather than to an error.

`getDatabaseType()` unconditionally returns `'powersync'`
([`src/lib/platform.ts:272`](../../src/lib/platform.ts#L272)), and both of its callers feed that
result straight into `getDatabasePath` ([`use-app-initialization.ts`](../../src/hooks/use-app-initialization.ts)
and [`src/lib/fs.ts`](../../src/lib/fs.ts)), so that function's `bun-sqlite` branch is dead. The
`bun-sqlite` database type itself lives on for bun tests, which construct a `Database` with an
explicit `:memory:` path ([`src/dal/test-utils.ts`](../../src/dal/test-utils.ts)) and never call
`getDatabasePath` at all. Do not hang new runtime behaviour off the database type expecting it to
vary by platform — it does not.

## Artefacts that are not live configuration

Three committed artefacts read as configuration and are not:

- `src-tauri/.env.example` documents `IMAP_*` variables and an `INPUT_FILE` for a feature that does
  not exist — nothing in `src-tauri/src` or `Cargo.toml` mentions IMAP.
- `src-tauri/test-embeddings.js` uses the Tauri v1 `window.__TAURI__.tauri` API and invokes an
  `init_embedder` command the crate does not define.
- `dist-isolation` is listed in `server.fs.allow` in `vite.config.ts`, resolved against the repo
  root. No such directory exists and `tauri.conf.json` declares no isolation pattern, so nothing
  reads it.

## Related documents

- [development/mobile-setup.md](../development/mobile-setup.md) — iOS/Android toolchains, the
  committed `gen/` trees, and which native sources are hand-maintained.
- [features/webview.md](../features/webview.md) — the embedded `WebView` sidebar and its per-platform
  engine behaviour.
- [features/tauri-signing-keys.md](../features/tauri-signing-keys.md) and
  [dev-tooling/local-cdn-for-app-update-testing.md](../dev-tooling/local-cdn-for-app-update-testing.md)
  — updater signing and testing the update flow end to end.
- [RELEASE.md](../../RELEASE.md) — desktop/mobile release workflows and the CLI release pipeline.
