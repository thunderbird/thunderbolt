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
