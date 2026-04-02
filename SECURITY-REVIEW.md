# Thunderbolt-2 Security & Quality Review

80 findings — 10 critical (6 fixed), 15 high, 27 medium (2 fixed), 28 low

## Critical

- **Unauthenticated inference/pro/proxy endpoints — anyone can burn API keys** — `backend/src/inference/routes.ts`, `backend/src/pro/routes.ts`, `backend/src/pro/proxy.ts` — Open
- **CORS regex allows `null` origin with credentials** — `backend/src/config/settings.ts:52,101` — **Fixed**
- **CSP effectively disabled in Tauri (`connect-src: *`, `unsafe-eval`, `unsafe-inline`)** — `src-tauri/tauri.conf.json:26,30` — **Fixed**
- **`postMessage` listener lacks origin validation** — `src/lib/auth.ts:142-165` — **Fixed**
- **Hardcoded `isProUser = true` bypass** — `src/integrations/thunderbolt-pro/utils.ts:4` — Open
- **Elysia 1.4.7 — CRITICAL prototype pollution + code injection** — `backend/package.json` — **Fixed** (→1.4.28)
- **`better-auth@1.4.2` — path normalization bypass** — `backend/package.json` — **Fixed** (→1.5.6)
- **`react-router@7.9.4` — XSS via open redirects** — `package.json` — **Fixed** (→7.13.2)
- **`kysely@0.28.8` — SQL injection via unsanitized JSON path keys** — via `better-auth`, `drizzle-orm` — **Fixed** (via better-auth update)
- **`@modelcontextprotocol/sdk@1.20.2` — DNS rebinding + data leak** — `package.json` — **Fixed** (→1.28.0)

## High

- **No rate limiting on cost-incurring endpoints (inference, Exa, email, proxy)** — All backend route files
- **OAuth tokens (access + refresh) stored as plaintext in local DB, synced via PowerSync unencrypted** — `src/hooks/use-oauth-connect.ts:130-147`
- **Auth bearer token stored in plaintext localStorage** — `src/lib/auth-token.ts:24-29`
- **PostHog proxy unauthenticated and unbounded (`all('/v1/posthog/*')`)** — `backend/src/posthog/routes.ts:29-58`
- **Google/Microsoft OAuth token exchange endpoints lack authentication** — `backend/src/auth/google.ts`, `backend/src/auth/microsoft.ts`
- **Open redirect in OAuth callback (`//evil.com` passes `startsWith('/')` check)** — `src/components/oauth-callback.tsx:50`
- **OAuth redirect flow missing CSRF state validation** — `src/components/oauth-callback.tsx:46-68`
- **Unpinned GitHub Actions — supply chain risk** — Most workflow files (ci.yml, desktop-release.yml, etc.)
- **Missing `permissions` blocks on CI workflows** — `desktop-release.yml`, `ios-release.yml`, `e2e.yml`, `test-build.yml`, `create-version-tag.yml`, `version-bump.yml`
- **Prompt injection via user-controlled data in system prompt** — `src/ai/prompt.ts:49-68,119`
- **Dev routes (`/message-simulator`, `/settings/dev-settings`) accessible in production** — `src/app.tsx:140,151`
- **API keys in `models` table synced unencrypted through PowerSync** — `src/db/tables.ts:86`, `powersync-service/config/config.yaml:25`
- **`upsertModelProfile` uses `onConflictDoUpdate` — crashes with PowerSync active** — `src/dal/model-profiles.ts:26-33`
- **PowerSync `DELETE` operations do hard deletes on backend** — `backend/src/dal/powersync.ts:123-130`
- **26 remaining dependency vulnerabilities (13 high, 12 moderate, 1 low) — mostly transitive dev deps** — `bun.lock`

## Medium

- **OTP exposed in email subject line** — `backend/src/auth/utils.tsx:83`
- **Account deletion has no re-authentication** — `backend/src/api/account.ts:33-40`
- **`x-device-id` header not validated for format/length** — `backend/src/api/powersync.ts:29`
- **Microsoft token refresh has no time buffer (Google has 60s buffer)** — `src/integrations/microsoft/tools.ts:161-183`
- **`buildUserIdHash` is not a hash — plaintext `${userAgent}:${clientIp}`** — `backend/src/utils/request.ts:43-48`
- **Hardcoded `localhost:8000` fallback in 5+ frontend files** — `src/components/chat/tool-icon.tsx:43`, `src/settings/devices.tsx:51`, etc.
- **Stale closure silently breaks analytics in content-view `close`** — `src/content-view/context.tsx:108-113`
- **Swagger UI enabled on all non-production environments** — `backend/src/index.ts:40-53`
- **Graceful shutdown doesn't drain connections or flush analytics** — `backend/src/index.ts:151-159`
- **Hardcoded PowerSync credentials in tracked files** — `powersync-service/init-db/01-powersync.sql:5`, `powersync-service/config/config.yaml:4,39`
- **Tauri isolation hook is a no-op (passes all IPC through)** — `dist-isolation/index.js`
- **`uuidv7ToDate` returns incorrect dates (reads 32 bits instead of 48)** — `src/lib/utils.ts:18-20`
- **Tauri HTTP transport temporarily overrides `globalThis.fetch`** — `src/lib/tauri-http-transport.ts:23-43`
- **Duplicate PKCE implementation in two files** — `src/lib/auth.ts:93-110` and `src/lib/pkce.ts:1-27`
- **`useMcpSync` infinite loop risk from circular deps** — `src/hooks/use-mcp-sync.tsx:17-53`
- **PKCE code verifier persisted in synced SQLite settings** — `src/hooks/use-oauth-connect.ts:200-206`
- **`memoize` function ignores arguments — cache key collision** — `src/lib/memoize.ts:34-60`
- **`tool-metadata.ts` unbounded cache growth** — `src/lib/tool-metadata.ts:18`
- **Database `initialize()` race condition (no mutex)** — `src/db/database.ts:15-54`
- **Missing indexes on backend `chat_messages.chat_thread_id` and `parent_id`** — `backend/src/db/powersync-schema.ts:56-74`
- **`settings` table has no `deletedAt` — `deleteSetting` hard deletes** — `src/dal/settings.ts:314-316`
- **`weather-forecast/lib.ts` `isDayTime` always returns wrong result for date-only strings** — `src/widgets/weather-forecast/lib.ts:30-38`
- **Onboarding dialog cannot be dismissed (softlock risk)** — `src/components/onboarding/onboarding-dialog.tsx:88`
- **`handleCelebrationComplete` missing `await` — may lose onboarding flag** — `src/components/onboarding/onboarding-dialog.tsx:52`
- **OIDC redirect follows unvalidated backend URL** — `src/components/oidc-redirect.tsx:35`
- **Missing FK `ON DELETE CASCADE` on `chat_messages.chat_thread_id`** — `backend/src/db/powersync-schema.ts:63`
- **Email normalization ignores Gmail dot trick and plus addressing** — `backend/src/lib/email.ts:6`
- **CORS `file://.*` allowed all file origins** — `backend/src/config/settings.ts` — **Fixed**
- **`.env.example` had `CORS_ALLOW_HEADERS=*`** — `backend/.env.example:59` — **Fixed**

## Low / Code Smells

- **`window.alert()` with developer instructions reachable in production** — `src/settings/integrations.tsx:168-172`
- **6x `console.log` in MCP connection testing (leaks server URLs + tools)** — `src/settings/mcp-servers.tsx:147-165`
- **Dead/stub components shipped (`message-preview`, `sideview`, `thread`, `message`, `app-sidebar`)** — Various `src/content-view/`, `src/components/`
- **~30+ `any` type violations (CLAUDE.md says "Never use `any`")** — Throughout integrations, middleware, types, DB layer
- **Duplicated streaming parser middleware (DRY violation)** — `src/ai/middleware/streaming-parser.ts` and `tool-calls.ts`
- **DOM element created/destroyed on every render for text measurement** — `src/settings/mcp-servers.tsx:263-278`
- **Array index used as React key during streaming** — `src/components/chat/assistant-message.tsx:138`
- **Deprecated `escape()`/`unescape()` Web APIs** — `src/integrations/google/utils.ts:48,113`
- **`release.yml` uses `secrets: inherit` everywhere** — `release.yml:46,58,68,78`
- **Inconsistent error response formats across backend** — Various backend routes
- **Stale references from removed features (IMAP env, LIBSQL_BUNDLED, duplicate FIREWORKS_API_KEY)** — `src-tauri/.env.example`, `.github/workflows/test-build.yml:73`, `backend/.env.example:2,26`
- **`backend/.env.test` tracked in git** — `.gitignore` only excludes `.env`, not `.env.test`
- **Missing `React.StrictMode`** — `src/index.tsx:17`
- **`console.info` in production sync paths** — `src/db/powersync/connector.ts:135,149`
- **Verbose AI response logging in production** — `src/ai/fetch.ts:305-327`
- **`h-[100vh]` vs `h-dvh` inconsistency on mobile** — `src/loading.tsx:12`
- **Cookie-based sidebar width persistence (sends to server on every request)** — `src/hooks/use-sidebar-resize.ts:207`
- **Hardcoded `untagged` release URLs with version 0.1.61** — `src/lib/download-links.ts:4-9`
- **`createParser` accesses Zod internals (`_def.values`)** — `src/lib/create-parser.ts:19`
- **Migration 0000 creates orphaned tutorial `users` table (dropped in 0003)** — `backend/drizzle/0000_superb_hannibal_king.sql`
- **`applySchema` test helper skips all partial indexes** — `src/db/apply-schema.ts:48-49`
- **"Email integration" hardcoded in retry message regardless of service type** — `src/hooks/use-handle-integration-completion.ts:46`
- **Fragile HTML detection in email body (`includes('<') && includes('>')`)** — `src/integrations/google/utils.ts:93-94`
- **PostHog `chat_send_prompt` leaks full model object** — `src/chats/chat-instance.ts:182-186`
- **`useSettings` hook recreates mutation functions on every render** — `src/hooks/use-settings.ts:212-266`
- **Theme application logic duplicated 3x in theme-provider** — `src/lib/theme-provider.tsx:63-128`

---

➜  thunderbolt-2 git:(cjroth/cleanup) semgrep scan

┌──── ○○○ ────┐
│ Semgrep CLI │
└─────────────┘

METRICS: Using configs from the Registry (like --config=p/ci) reports pseudonymous rule metrics to semgrep.dev.
To disable Registry rule metrics, use "--metrics=off".
When using configs only from local files (like --config=xyz.yml) metrics are sent only when the user is logged in.

More information: https://semgrep.dev/docs/metrics

⠸ Loading rules from registry...                                                                                                             Scanning 943 files (only git-tracked) with:

✔ Semgrep OSS
  ✔ Basic security coverage for first-party code vulnerabilities.

✔ Semgrep Code (SAST)
  ✔ Find and fix vulnerabilities in the code you write with advanced scanning and expert security rules.

✘ Semgrep Supply Chain (SCA)
  ✘ Find and fix the reachable vulnerabilities in your OSS dependencies.

  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 100% 0:04:25


┌──────────────────┐
│ 24 Code Findings │
└──────────────────┘

    .github/actions/determine-version/action.yml
   ❯❯❱ yaml.github-actions.security.run-shell-injection.run-shell-injection
          ❰❰ Blocking ❱❱
          Using variable interpolation `${{...}}` with `github` context data in a `run:` step could allow an
          attacker to inject their own code into the runner. This would allow them to steal secrets and code.
          `github` context data can have arbitrary user input and should be treated as untrusted. Instead, use
          an intermediate environment variable with `env:` to store the data and use the environment variable
          in the `run:` script. Be sure to use double-quotes the environment variable, like this: "$ENVVAR".
          Details: https://sg.run/pkzk

           21┆ run: |
           22┆   INPUT_VERSION="${{ inputs.version }}"
           23┆   VERSION_TYPE_INPUT="${{ inputs.version_type }}"
           24┆
           25┆   CURRENT_VERSION=$(node -p "require('./package.json').version")
           26┆
           27┆   if [ -n "$INPUT_VERSION" ]; then
           28┆     BUILD_VERSION="$INPUT_VERSION"
           29┆     echo "Using explicit version: $BUILD_VERSION"
           30┆   else
             [hid 32 additional lines, adjust with --max-lines-per-finding]

    .github/actions/upload-to-play/action.yml
   ❯❯❱ yaml.github-actions.security.run-shell-injection.run-shell-injection
          ❰❰ Blocking ❱❱
          Using variable interpolation `${{...}}` with `github` context data in a `run:` step could allow an
          attacker to inject their own code into the runner. This would allow them to steal secrets and code.
          `github` context data can have arbitrary user input and should be treated as untrusted. Instead, use
          an intermediate environment variable with `env:` to store the data and use the environment variable
          in the `run:` script. Be sure to use double-quotes the environment variable, like this: "$ENVVAR".
          Details: https://sg.run/pkzk

           32┆ run: |
           33┆   # Write service account JSON to file to avoid shell escaping issues
           34┆   echo '${{ inputs.serviceAccountJson }}' > /tmp/service-account.json
           35┆
           36┆   # Set environment variables
           37┆   export PACKAGE_NAME="${{ inputs.packageName }}"
           38┆   export AAB_PATH="${{ inputs.aabPath }}"
           39┆   export TRACK="${{ inputs.track }}"
           40┆   export SERVICE_ACCOUNT_FILE="/tmp/service-account.json"
           41┆
             [hid 5 additional lines, adjust with --max-lines-per-finding]

    .github/workflows/android-release.yml
   ❯❯❱ yaml.github-actions.security.run-shell-injection.run-shell-injection
          ❰❰ Blocking ❱❱
          Using variable interpolation `${{...}}` with `github` context data in a `run:` step could allow an
          attacker to inject their own code into the runner. This would allow them to steal secrets and code.
          `github` context data can have arbitrary user input and should be treated as untrusted. Instead, use
          an intermediate environment variable with `env:` to store the data and use the environment variable
          in the `run:` script. Be sure to use double-quotes the environment variable, like this: "$ENVVAR".
          Details: https://sg.run/pkzk

           83┆ run: |
           84┆   if [ "${{ inputs.nightly }}" == "true" ]; then
           85┆     echo "🌙 Nightly build"
           86┆   fi
           87┆   if [ -n "${{ inputs.version }}" ]; then
           88┆     echo "🏷️ Using specified version: ${{ inputs.version }}"
           89┆   else
           90┆     CURRENT_VERSION=$(node -p "require('./package.json').version")
           91┆     echo "📦 Current version: $CURRENT_VERSION"
           92┆   fi
             [hid 1 additional lines, adjust with --max-lines-per-finding]

    .github/workflows/create-version-tag.yml
   ❯❯❱ yaml.github-actions.security.run-shell-injection.run-shell-injection
          ❰❰ Blocking ❱❱
          Using variable interpolation `${{...}}` with `github` context data in a `run:` step could allow an
          attacker to inject their own code into the runner. This would allow them to steal secrets and code.
          `github` context data can have arbitrary user input and should be treated as untrusted. Instead, use
          an intermediate environment variable with `env:` to store the data and use the environment variable
          in the `run:` script. Be sure to use double-quotes the environment variable, like this: "$ENVVAR".
          Details: https://sg.run/pkzk

           51┆ run: |
           52┆   if [ -n "${{ inputs.version }}" ]; then
           53┆     # User specified exact version
           54┆     NEW_VERSION="${{ inputs.version }}"
           55┆     echo "✨ Using specified version: $NEW_VERSION"
           56┆   else
           57┆     # Auto-detect from commits
           58┆     CURRENT_VERSION="${{ steps.current_version.outputs.current_version }}"
           59┆
           60┆     # Get commits since last tag
             [hid 43 additional lines, adjust with --max-lines-per-finding]

    .github/workflows/desktop-release.yml
   ❯❯❱ yaml.github-actions.security.run-shell-injection.run-shell-injection
          ❰❰ Blocking ❱❱
          Using variable interpolation `${{...}}` with `github` context data in a `run:` step could allow an
          attacker to inject their own code into the runner. This would allow them to steal secrets and code.
          `github` context data can have arbitrary user input and should be treated as untrusted. Instead, use
          an intermediate environment variable with `env:` to store the data and use the environment variable
          in the `run:` script. Be sure to use double-quotes the environment variable, like this: "$ENVVAR".
          Details: https://sg.run/pkzk

           46┆ run: |
           47┆   echo "version=v${{ inputs.version }}" >> $GITHUB_OUTPUT
           48┆

    .github/workflows/ios-release.yml
   ❯❯❱ yaml.github-actions.security.run-shell-injection.run-shell-injection
          ❰❰ Blocking ❱❱
          Using variable interpolation `${{...}}` with `github` context data in a `run:` step could allow an
          attacker to inject their own code into the runner. This would allow them to steal secrets and code.
          `github` context data can have arbitrary user input and should be treated as untrusted. Instead, use
          an intermediate environment variable with `env:` to store the data and use the environment variable
          in the `run:` script. Be sure to use double-quotes the environment variable, like this: "$ENVVAR".
          Details: https://sg.run/pkzk

           80┆ run: |
           81┆   if [ "${{ inputs.nightly }}" == "true" ]; then
           82┆     echo "🌙 Nightly build"
           83┆   fi
           84┆   if [ -n "${{ inputs.version }}" ]; then
           85┆     echo "🏷️ Using specified version: ${{ inputs.version }}"
           86┆   else
           87┆     CURRENT_VERSION=$(node -p "require('./package.json').version")
           88┆     echo "📦 Current version: $CURRENT_VERSION"
           89┆   fi
             [hid 1 additional lines, adjust with --max-lines-per-finding]

    .github/workflows/test-build.yml
   ❯❯❱ yaml.github-actions.security.run-shell-injection.run-shell-injection
          ❰❰ Blocking ❱❱
          Using variable interpolation `${{...}}` with `github` context data in a `run:` step could allow an
          attacker to inject their own code into the runner. This would allow them to steal secrets and code.
          `github` context data can have arbitrary user input and should be treated as untrusted. Instead, use
          an intermediate environment variable with `env:` to store the data and use the environment variable
          in the `run:` script. Be sure to use double-quotes the environment variable, like this: "$ENVVAR".
          Details: https://sg.run/pkzk

           45┆ run: |
           46┆   bun install
           47┆
           48┆   case "${{ inputs.platform }}" in
           49┆     "linux")
           50┆       bun tauri build
           51┆       ;;
           52┆     "windows-x64")
           53┆       bun tauri build --bundles msi,nsis --target x86_64-pc-windows-msvc
           54┆       ;;
             [hid 13 additional lines, adjust with --max-lines-per-finding]

    .github/workflows/version-bump.yml
   ❯❯❱ yaml.github-actions.security.run-shell-injection.run-shell-injection
          ❰❰ Blocking ❱❱
          Using variable interpolation `${{...}}` with `github` context data in a `run:` step could allow an
          attacker to inject their own code into the runner. This would allow them to steal secrets and code.
          `github` context data can have arbitrary user input and should be treated as untrusted. Instead, use
          an intermediate environment variable with `env:` to store the data and use the environment variable
          in the `run:` script. Be sure to use double-quotes the environment variable, like this: "$ENVVAR".
          Details: https://sg.run/pkzk

           83┆ run: |
           84┆   # Build arguments for the script
           85┆   ARGS="--push"
           86┆
           87┆   if [ -n "${{ inputs.version }}" ]; then
           88┆     ARGS="$ARGS --version ${{ inputs.version }}"
           89┆   else
           90┆     ARGS="$ARGS --type ${{ inputs.version_type }}"
           91┆   fi
           92┆
             [hid 7 additional lines, adjust with --max-lines-per-finding]
          132┆ run: |
          133┆   # Get the version from package.json (which was just updated)
          134┆   NEW_VERSION=$(node -p "require('./package.json').version")
          135┆   echo "new_version=$NEW_VERSION" >> $GITHUB_OUTPUT
          136┆   echo "📦 Version: $NEW_VERSION"
          137┆
          138┆   # Output the version type
          139┆   VERSION_TYPE="${{ inputs.version_type }}"
          140┆   echo "version_type=$VERSION_TYPE" >> $GITHUB_OUTPUT
          141┆   echo "📝 Version type: $VERSION_TYPE"
             [hid 1 additional lines, adjust with --max-lines-per-finding]
          145┆ run: |
          146┆   NEW_VERSION="${{ steps.version.outputs.new_version }}"
          147┆   PLATFORM="${{ inputs.platform }}"
          148┆
          149┆   # Determine tag name based on platform
          150┆   if [ "$PLATFORM" == "all" ] || [ -z "$PLATFORM" ]; then
          151┆     TAG_NAME="v$NEW_VERSION"
          152┆   else
          153┆     TAG_NAME="v$NEW_VERSION-$PLATFORM-rc"
          154┆   fi
             [hid 4 additional lines, adjust with --max-lines-per-finding]
          181┆ run: |
          182┆   # Decode the changelog
          183┆   CHANGELOG=$(echo "${{ steps.changelog.outputs.changelog_b64 }}" | base64 -d)
          184┆
          185┆   PLATFORM="${{ inputs.platform }}"
          186┆   TAG_NAME="${{ steps.tag.outputs.tag_name }}"
          187┆   VERSION="${{ steps.version.outputs.new_version }}"
          188┆   VERSION_TYPE="${{ steps.version.outputs.version_type }}"
          189┆
          190┆   # Create release using GitHub CLI
             [hid 38 additional lines, adjust with --max-lines-per-finding]

    .thunderbot/assess.ts
    ❯❱ javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
          ❰❰ Blocking ❱❱
          RegExp() called with a `word` function argument, this might allow an attacker to cause a Regular
          Expression Denial-of-Service (ReDoS) within your application as RegExP blocks the main thread. For
          this reason, it is recommended to use hardcoded regexes instead. If your regex is run on user-
          controlled input, consider performing input validation or use a regex checking/sanitization library
          such as https://www.npmjs.com/package/recheck to verify that the regex does not appear vulnerable to
          ReDoS.
          Details: https://sg.run/gr65

           15┆ new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text)

    .thunderbot/cli/repo.ts
   ❯❯❱ javascript.lang.security.detect-child-process.detect-child-process
          ❰❰ Blocking ❱❱
          Detected calls to child_process from a function argument `cmd`. This could lead to a command
          injection if the input is user controllable. Try to avoid calls to child_process, and if it is
          needed ensure user input is correctly sanitized or sandboxed.
          Details: https://sg.run/l2lo

           12┆ const proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] })

    .thunderbot/daemon.ts
   ❯❯❱ javascript.lang.security.audit.spawn-shell-true.spawn-shell-true
          ❰❰ Blocking ❱❱
          Found '$SPAWN' with '{shell: true}'. This is dangerous because this call will spawn the command
          using a shell process. Doing so propagates current shell settings and variables, which makes it much
          easier for a malicious actor to execute commands. Use '{shell: false}' instead.
          Details: https://sg.run/Wgeo

           83┆ spawnSync('command', ['-v', cmd], { stdio: 'pipe', shell: true }).status === 0

   ❯❯❱ javascript.lang.security.detect-child-process.detect-child-process
          ❰❰ Blocking ❱❱
          Detected calls to child_process from a function argument `cmd`. This could lead to a command
          injection if the input is user controllable. Try to avoid calls to child_process, and if it is
          needed ensure user input is correctly sanitized or sandboxed.
          Details: https://sg.run/l2lo

          131┆ const proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] })

    backend/src/config/settings.ts
    ❯❱ javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
          ❰❰ Blocking ❱❱
          RegExp() called with a `settings` function argument, this might allow an attacker to cause a Regular
          Expression Denial-of-Service (ReDoS) within your application as RegExP blocks the main thread. For
          this reason, it is recommended to use hardcoded regexes instead. If your regex is run on user-
          controlled input, consider performing input validation or use a regex checking/sanitization library
          such as https://www.npmjs.com/package/recheck to verify that the regex does not appear vulnerable to
          ReDoS.
          Details: https://sg.run/gr65

          145┆ return settings.corsOriginRegex ? new RegExp(settings.corsOriginRegex) :
               getCorsOriginsList(settings)

    scripts/create-release.ts
   ❯❯❱ javascript.lang.security.detect-child-process.detect-child-process
          ❰❰ Blocking ❱❱
          Detected calls to child_process from a function argument `command`. This could lead to a command
          injection if the input is user controllable. Try to avoid calls to child_process, and if it is
          needed ensure user input is correctly sanitized or sandboxed.
          Details: https://sg.run/l2lo

           38┆ const result = execSync(command, {

    scripts/upload-to-play.cjs
     ❱ javascript.lang.security.audit.unsafe-formatstring.unsafe-formatstring
          ❰❰ Blocking ❱❱
          Detected string concatenation with a non-literal variable in a util.format / console.log function.
          If an attacker injects a format specifier in the string, it will forge the log message. Try to use
          constant values for the format string.
          Details: https://sg.run/7Y5R

           82┆ console.log(`✅ Track set to ${track}:`, trackResponse.data)

    src-tauri/Info.plist
    ❯❱ swift.insecure-communication.ats.ats-pinning.ATS-consider-pinning
          ❰❰ Blocking ❱❱
          The application's App Transport Security (ATS) configuration does not leverage the in-built public
          key pinning mechanisms. The application should consider leverage ATS public key pinning to ensure
          that the application only communicates to serves with an allow-listed certificate (and public key).
          By default the device will allow connections if the default trust store (CA store) posesses the
          right certificates. The number of accepted Certificate Authorities by default is hundreds. Using
          public key pinning vastly reduces the attack surface.
          Details: https://sg.run/8lWj

            3┆ <plist version="1.0">
            4┆     <dict>
            5┆         <!-- These values will get merged with the values created by Tauri CLI:
            6┆         https://tauri.app/distribute/macos-application-bundle/#native-configuration -->
            7┆         <!-- @todo - this should be disabled for release! -->
            8┆         <key>UIFileSharingEnabled</key>
            9┆         <true />
           10┆         <key>LSSupportsOpeningDocumentsInPlace</key>
           11┆         <true />
           12┆         <key>ITSAppUsesNonExemptEncryption</key>
             [hid 3 additional lines, adjust with --max-lines-per-finding]

    src-tauri/gen/android/app/src/main/AndroidManifest.xml
    ❯❱ java.android.security.exported_activity.exported_activity
          ❰❰ Blocking ❱❱
          The application exports an activity. Any application on the device can launch the exported activity
          which may compromise the integrity of your application or its data.  Ensure that any exported
          activities do not have privileged access to your application's control plane.
          Details: https://sg.run/eNGZ

           13┆ <activity
           14┆     android:configChanges="orientation|keyboardHidden|keyboard|screenSize|locale|smallestS
               creenSize|screenLayout|uiMode"
           15┆     android:launchMode="singleTask"
           16┆     android:label="@string/main_activity_title"
           17┆     android:name=".MainActivity"
           18┆     android:exported="true">
           19┆     <intent-filter>
           20┆         <action android:name="android.intent.action.MAIN" />

    src-tauri/gen/apple/thunderbolt_iOS/Info.plist
    ❯❱ swift.insecure-communication.ats.ats-pinning.ATS-consider-pinning
          ❰❰ Blocking ❱❱
          The application's App Transport Security (ATS) configuration does not leverage the in-built public
          key pinning mechanisms. The application should consider leverage ATS public key pinning to ensure
          that the application only communicates to serves with an allow-listed certificate (and public key).
          By default the device will allow connections if the default trust store (CA store) posesses the
          right certificates. The number of accepted Certificate Authorities by default is hundreds. Using
          public key pinning vastly reduces the attack surface.
          Details: https://sg.run/8lWj

            3┆ <plist version="1.0">
            4┆ <dict>
            5┆   <key>CFBundleDevelopmentRegion</key>
            6┆   <string>$(DEVELOPMENT_LANGUAGE)</string>
            7┆   <key>CFBundleExecutable</key>
            8┆   <string>$(EXECUTABLE_NAME)</string>
            9┆   <key>CFBundleIdentifier</key>
           10┆   <string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
           11┆   <key>CFBundleInfoDictionaryVersion</key>
           12┆   <string>6.0</string>
             [hid 38 additional lines, adjust with --max-lines-per-finding]

    src/ai/fetch.ts
     ❱ javascript.lang.security.audit.unsafe-formatstring.unsafe-formatstring
          ❰❰ Blocking ❱❱
          Detected string concatenation with a non-literal variable in a util.format / console.log function.
          If an attacker injects a format specifier in the string, it will forge the log message. Try to use
          constant values for the format string.
          Details: https://sg.run/7Y5R

          345┆ console.warn(`Tool call error for "${toolCall.toolName}":`, error)

    src/ai/streaming/sse-logs.test.ts
     ❱ javascript.lang.security.audit.unsafe-formatstring.unsafe-formatstring
          ❰❰ Blocking ❱❱
          Detected string concatenation with a non-literal variable in a util.format / console.log function.
          If an attacker injects a format specifier in the string, it will forge the log message. Try to use
          constant values for the format string.
          Details: https://sg.run/7Y5R

           52┆ console.warn(`Warning: Cannot parse SSE file ${entry}:`, error)

    src/ai/streaming/util.ts
     ❱ javascript.lang.security.audit.unsafe-formatstring.unsafe-formatstring
          ❰❰ Blocking ❱❱
          Detected string concatenation with a non-literal variable in a util.format / console.log function.
          If an attacker injects a format specifier in the string, it will forge the log message. Try to use
          constant values for the format string.
          Details: https://sg.run/7Y5R

          173┆ console.log(`[Simulated Tool] ${String(prop)}`, ...args)



┌──────────────┐
│ Scan Summary │
└──────────────┘
✅ Scan completed successfully.
 • Findings: 24 (24 blocking)
 • Rules run: 676
 • Targets scanned: 943
 • Parsed lines: ~99.9%
 • Scan was limited to files tracked by git
 • For a detailed list of skipped files and lines, run semgrep with the --verbose flag
Ran 676 rules on 943 files: 24 findings.
