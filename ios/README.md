# Experimental native iOS client

**Experiment — work in progress, not ready to merge or ship.** This directory captures an exploration of a Swift iOS client that preserves Thunderbolt's Tauri mobile layout while using native menus, drawers, and platform services. It is not a feature-complete replacement. Some recent connection and agent code is still being integrated, and the complete visual and end-to-end regression suite is not green yet.

**Current snapshot build status:** the complete native target does not yet compile. `NativeMCPTransport.swift` has Swift concurrency diagnostics around captured protocol/session state and RPC closures crossing isolation boundaries. Earlier builds of the core app ran in the simulator; they do not validate this final combined snapshot. Resolve the MCP isolation model before using the build/test instructions below.

This SwiftUI app is a standalone iOS client for Thunderbolt Cloud. It targets iOS 18. The Xcode project is `Thunderbolt.xcodeproj`; its shared `Thunderbolt` scheme includes the app, unit tests, and UI tests. The reference for layout and behavior is the Tauri **iOS** app; native controls do not change the placement of navigation, model selection, or chat actions.

## Run locally

1. Install the backend dependencies used by both the API and fake provider:

   ```sh
   cd backend && bun install --frozen-lockfile
   cd ..
   ```

2. Start the repository backend and deterministic fake Anthropic provider:

   ```sh
   ./ios/scripts/local-backend.sh
   ```

   The script uses an isolated temporary PGlite database, test-only email OTP (`12345678`), and the fake provider in `e2e/fake-provider.ts`. It refuses to start if ports 18080 or 18787 are already in use. Press Ctrl+C to stop the processes it started and remove its temporary database.

3. Open `ios/Thunderbolt.xcodeproj` in Xcode, choose an iOS 18+ simulator, and run the `Thunderbolt` scheme. Keep Xcode’s normal simulator code signing enabled so Keychain-backed sessions work. Before the first sign-in, open **Product → Scheme → Edit Scheme → Run → Arguments → Environment Variables** and add:

   ```text
   THUNDERBOLT_SERVER_URL=http://localhost:18080/v1
   ```

   Sign in as `croth@thunderbolt.io` with code `12345678`. You can also use **Change server** on the sign-in screen, or **History → Settings** after signing in. Confirm the local address shown beneath the sign-in controls before requesting a code.

The UI test configures the same local URL and isolated UI-test storage itself. It exercises invalid and valid OTP entry, streamed chat, a follow-up turn, starting a new chat and reopening history, persistence across relaunch, stopping a long Markdown response, and sign-out. A separate deletion test creates a disposable localhost account and verifies step-up OTP plus the explicit destructive confirmation. It verifies that history opens from the left and attaches sign-in, empty-chat, sidebar, and streamed-chat screenshots to the test result.

### Organization escrow key

For deployments with organization escrow enabled, set the Xcode build setting `THUNDERBOLT_ORG_ESCROW_PUBLIC_KEY` through the deployment's `.xcconfig` to the same pinned Base64 uncompressed SEC1 P-256 public key used for `VITE_ORG_ESCROW_PUBLIC_KEY`. The app reads it from `ThunderboltOrgEscrowPublicKey` in its processed Info.plist and never obtains an escrow key from the server. Leave the build setting empty when escrow is disabled.

### Native passkeys

The native target requests the `webcredentials:app.thunderbolt.io` Associated Domain. The matching `BUMSKVQ3D9.net.thunderbird.thunderbolt.native` app identifier is listed in `public/.well-known/apple-app-site-association`; Apple must be able to fetch that file from the RP domain over HTTPS, and the app must be signed with the matching Associated Domains entitlement. This repository change prepares those source files only; it does not publish the AASA file or update the App ID provisioning profile.

The current native ceremony is pinned to the production RP ID `app.thunderbolt.io` and requires iOS 18 for AuthenticationServices PRF input/output. A self-hosted deployment must configure its RP ID, trusted web origin, AASA app identifier, and matching entitlement before passkey registration or local unlock can work. The backend must have passkeys enabled. XCTest can verify the settings and key-derivation plumbing, but it cannot reliably automate the system passkey sheet or create an enrolled iCloud Keychain credential; complete enrollment and unlock validation on a signed device with the RP domain configured.

### Tinfoil OAuth universal link

Native Tinfoil account enrollment uses the system browser and a one-time PKCE callback at `https://app.thunderbolt.io/oauth/callback`. The verifier and pending state stay in Keychain; access and refresh tokens stay in the device-local provider credential table. The source entitlement and AASA configuration must be installed before this flow can return to the app: publish the native bundle identifier under `applinks` at `https://app.thunderbolt.io/.well-known/apple-app-site-association`, and sign the app with the matching Associated Domains entitlement. This repository change prepares source only; it does not publish the AASA file or alter the Apple App ID profile. Tinfoil attestation status shown by the native client comes from the official SDK verification callbacks, never from model metadata.

## Implemented baseline

- Email one-time-code sign-in and device-local Keychain session storage.
- Text chat through the managed Thunderbolt backend, including streamed hosted-agent responses.
- Device-local conversation history, isolated by account and server.
- Light and dark appearance, using the system appearance.
- Tauri mobile navigation: a left drawer with New Chat in its footer, native glass header controls, and model selection beside Send in the composer.
- Native Markdown code blocks and tables, reasoning/tool groups, citation metadata, and verified HTML artifact previews.
- Encrypted PowerSync storage with first-device bootstrap, protected device keys, session binding, and prototype-history migration.
- Recovery and device-approval flows, currently under expanded protocol verification.
- Per-conversation response tasks and drafts, plus local file/photo import and attachment delivery, currently under UI regression verification.

The full parity port is in progress. The local integration suite has verified first-device bootstrap, rebind after a fresh sign-in, encrypted replication between two independent PowerSync databases, and native sync setup/relaunch. This is not yet a feature-complete replacement for the Tauri app; the checklist below tracks the remaining integration and verification work.

Remote ACP chat orchestration and the unified MCP Connections UI are unfinished. The Iroh transport prototype is preserved in [`Experiments/Iroh`](Experiments/Iroh/README.md), outside the app target; the app currently reports Iroh MCP connections as unsupported. Preferences, search-provider settings, localization and visual parity also need further work. Simulator coverage does not replace signed-device validation of passkeys, universal links, audio and provisioning.

## Parity work in progress

Unchecked items below are not completion claims. Each area needs implementation, integration, and verification against the Tauri client, including failure and relaunch behavior.

- [x] Email OTP, local session restore, logout, server selection.
- [x] Streaming text, stop/retry, device-local history, account isolation.
- [ ] Visual parity: left drawer, drawer-footer New Chat, circular glass header controls and bottom model selector are present; spacing, typography, settings and interaction details still need comparison and refinement.
- [ ] Encrypted PowerSync storage, first-device bootstrap, recovery phrase, approval, device binding, rotation, revocation and account deletion.
- [ ] Cross-client data compatibility, migration of prototype history, offline edits and sync convergence.
- [ ] Rich message parts: Markdown tables/code, reasoning, tool activity, citations, attachments and artifacts.
- [ ] Built-in agent engine: tools, permissions, workspace, compaction, usage, reasoning controls, concurrent conversations.
- [ ] Full model catalog, provider connections, confidential inference, private-thread rules and model profiles.
- [ ] Chat management and message actions, including rename, deletion, pinning, search and reply behavior, verified against the actual Tauri iOS surface.
- [ ] Projects, skills, prompts, tasks and triggers available on Tauri iOS.
- [ ] Image/file import, conversion, previews and agent workspace handoff.
- [ ] Voice capture/playback, interruptions and microphone lifecycle.
- [ ] ACP and MCP connections, OAuth/deep links and reconnect behavior.
- [ ] Account, device, usage, preferences, appearance, language and accessibility settings.
- [ ] SSO, passkeys and self-hosted/standalone deployment behavior.
- [ ] Regression suite, native UI smoke, visual comparison, offline/relaunch/revocation cases and physical-device validation.

Desktop-only tray, CLI installation and web/desktop Mini Apps are outside the Tauri iOS reference. The native client keeps wire-compatible encrypted values inside PowerSync tables and decrypts at its repository boundary; it does not depend on PowerSync's private bucket middleware APIs.

## Checks

With the local backend running, run both test targets with Xcode’s **Product → Test**. From the repository root, a simulator-only command is:

```sh
xcodebuild -project ios/Thunderbolt.xcodeproj -scheme Thunderbolt \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -parallel-testing-enabled NO CODE_SIGN_IDENTITY=- test
```

Choose a simulator name installed on your Mac. For unit tests without a backend, add `-only-testing:ThunderboltTests`. The UI tests require the helper’s default ports, use separate Keychain/history storage, and stop immediately if the displayed server is not localhost. Debug server overrides are deliberately unavailable in Release builds. A normal installation defaults to `https://api.thunderbolt.io/v1`; server settings are available in both builds.

The simulator integration uses the real backend authentication and inference routes with the repository’s deterministic provider. It verifies transport and app behavior, not the quality or availability of a production model. On a physical device, select your Apple development team in Xcode; plain HTTP is allowed only for loopback development, so a remote development server needs HTTPS.

`Thunderbolt/Fonts/MozillaHeadline-Medium.ttf` is a 500-weight static instance of the same Mozilla Headline font used by the web app, converted from the locked `@fontsource-variable/mozilla-headline` package. Its OFL license is included alongside it. App screens are SwiftUI. HTML artifacts use an isolated WKWebView with the same content security policy as Tauri; the agent engine uses JavaScriptCore to run the shared Pi harness. Markdown paragraphs, headings, lists, quotes, code, tables and math render as native views; rendering parity still needs broader verification.

## Encrypted PowerSync integration test

Run the first-device bootstrap, device rebind, encrypted cross-client replication, recovery-phrase setup, and relaunch restore flows with the real local PostgreSQL and PowerSync services:

```sh
cd backend && bun install --frozen-lockfile
cd ..
./ios/scripts/test-sync.sh
```

The script creates an isolated Compose project and database volume, runs the backend Drizzle migrations, starts only its own API process, builds the app and test bundles, injects local URLs into the unit-test and UI-test `.xctestrun` entries, then runs `DeviceIntegrationTests.testBootstrapRebindAndEncryptedPowerSyncReplication` followed by the native UI test target on the same simulator. It removes the backend process and the Compose project it created when the command exits. Result bundles and logs are kept in the temporary directory. It requires Docker, Bun, Xcode command line tools, and an installed iOS simulator matching `SIMULATOR_DESTINATION` (default: iPhone 17 Pro).

The script refuses occupied ports or an existing Compose project. To explicitly reuse a running isolated stack, pass its project name, the opt-in flag, and a free backend port; the script will not stop that stack:

```sh
THUNDERBOLT_REUSE_SYNC_STACK=1 \
  SYNC_COMPOSE_PROJECT=thunderbolt-native-ios-sync \
  BACKEND_PORT=18084 \
  ./ios/scripts/test-sync.sh
```

For source snapshots that already have compiled test products, skip rebuilding with both paths from the same DerivedData build:

```sh
THUNDERBOLT_SYNC_DERIVED_DATA=/tmp/thunderbolt-native-build \
THUNDERBOLT_SYNC_XCTESTRUN=/tmp/thunderbolt-native-build/Build/Products/Thunderbolt_iphonesimulator26.5-arm64.xctestrun \
./ios/scripts/test-sync.sh
```

The supplied plan must be directly inside that DerivedData directory’s `Build/Products`, contain both test targets, and have both compiled test bundles present. The helper writes an environment-configured copy beside the plan and leaves the original build products alone.

Set `BACKEND_PORT`, `POWERSYNC_PORT`, and `POSTGRES_PORT` to change the default ports `18083`, `18082`, and `15434`. The test generates a fresh test account and uses only localhost endpoints; do not point it at production or a shared account.
