# Architecture Invariants (INV-01..INV-80)

Global properties that survive across subsystems. Verify any change against the relevant ones; cite `INV-NN` when a finding rests on one. Condensed from the architecture deep-dive — read the full `01..10-*.md` docs for detail.

## Index (titles)
- Identity & Tenancy: INV-01..05
- Trust & Auth: INV-06..13
- E2E Encryption: INV-14..29
- Sync Pipeline: INV-30..37
- Persistence & Soft-Delete: INV-38..48
- Backend Skeleton: INV-49..61
- AI / Chat / MCP: INV-62..70
- Frontend Devices & Reset: INV-71..74
- Tauri Shell: INV-75..80

## Identity & Tenancy
- **INV-01** `user_id` always from JWT, never client payload; sync rules scope every row by `user_id = request.user_id()`. Cross-tenant leak structurally impossible.
- **INV-02** `X-Device-ID` mandatory on every PowerSync token request + upload (400 `DEVICE_ID_REQUIRED`).
- **INV-03** Device id is client-generated UUID v4 in `localStorage[thunderbolt_device_id]`; backend never mints.
- **INV-04** Email stored lowercase (`normalizeEmail`); lookups must normalize.
- **INV-05** PR-preview envs bypass auth (`shouldBypassWaitlist`).

## Trust & Authentication
- **INV-06** Bearer = `rawToken.HMAC_b64`; verified with `timingSafeEqual`; PowerSync path-2 verifies signature independently.
- **INV-07** `tauri://localhost` always trusted origin; backend's own origin auto-added.
- **INV-08** `accountLinking.trustedProviders=['sso']` only when authMode ∈ {oidc, saml}.
- **INV-09** OTP sign-in requires `x-challenge-token` + existing-user-or-approved-waitlist (defense in depth).
- **INV-10** OAuth integration secrets never leave backend (confidential-client proxy).
- **INV-11** OAuth redirect URIs: exact CORS match + hardcoded app URL + loopback any-port; HTTPS-on-localhost rejected.
- **INV-12** Tauri loopback ports fixed `[17421,17422,17423]`, shared Rust↔backend; PKCE per RFC 8252.
- **INV-13** Post-update redirect flag set before relaunch; consumed once.

## E2E Encryption (E2EE_ENABLED)
- **INV-14** CK is AES-256-GCM, single algo/length everywhere.
- **INV-15** Hybrid envelope V1 (`0x01`), exactly 1194 bytes.
- **INV-16** Wrapping key one-shot, HKDF-SHA-256 over `ssEcdh||ssMlkem`.
- **INV-17** CK never leaves device extractable (transient only at setup/recovery).
- **INV-18** CK invalidation broadcasts via `BroadcastChannel('thunderbolt-ck-invalidation')`.
- **INV-19** Codec encode fail-closed in steady state (`e2eeSetupComplete && !ck` throws).
- **INV-20** Codec decode tolerant — passes through on missing CK / decrypt error (warns only; never breaks sync).
- **INV-21** Trust transition atomic — upsertEnvelope + markDeviceTrusted in one tx.
- **INV-22** Revoke atomic — deleteEnvelope + revokeDevice + revokeDeviceSessions in one tx.
- **INV-23** Trusted device envelope overwrite-protected (only the device re-keys).
- **INV-24** Approval requires canary proof AND trusted-caller.
- **INV-25** Re-bootstrap requires old canary secret.
- **INV-26** Canary hash compare constant-time.
- **INV-27** Device limit 10 active/user, enforced in-tx.
- **INV-28** First-device flow returns recovery key exactly once (in-memory).
- **INV-29** Approve-device never touches local non-extractable CK.

## Sync Pipeline
- **INV-30** Empty transformer pipeline ⇒ byte-identical to `SqliteBucketStorage`.
- **INV-31** Re-encoded payload always same wire format (JSON/BSON in = out).
- **INV-32** Two sync paths — custom SharedWorker (Chrome/Edge/FF) vs main-thread transformer (Safari/iOS/Tauri).
- **INV-33** `@powersync/web` `@internal` override via `powersync-web-internal` alias — brittle across upgrades; re-verify `generateStreamingImplementation()`.
- **INV-34** HTTP streaming, not WebSockets (`SyncStreamConnectionMethod.HTTP`).
- **INV-35** `fetchCredentials` returns `null` (not throw) on auth failure.
- **INV-36** `uploadData` throws on failure, never `transaction.complete()` — PowerSync retries.
- **INV-37** Error→reset mapping: 410→account_deleted; 403 DEVICE_DISCONNECTED→device_revoked; 409 DEVICE_ID_TAKEN→reset; 400 DEVICE_ID_REQUIRED→reset; 401→session_expired.

## Persistence & Soft-Delete
- **INV-38** Frontend NEVER hard-deletes — `deletedAt = nowIso()`. Hard delete only in account/device flows.
- **INV-39** Backend prefers soft-delete; hard delete only for account deletion, PowerSync DELETE, device revoke.
- **INV-40** `settings` is the only frontend table without `deletedAt` (only hard-delete in frontend DAL).
- **INV-41** `deletedAt IS NULL` filtered at WHERE + partial indexes.
- **INV-42** `clearNullableColumns` nulls every nullable non-PK/FK/unique col except `deletedAt`/`userId`.
- **INV-43** Cascades hand-rolled in DAL (backend FKs intentionally omitted).
- **INV-44** Insert-then-update upsert (PowerSync views lack `ON CONFLICT`).
- **INV-45** `isInsertConflictError` unwraps `error.cause` (Drizzle wraps).
- **INV-46** Composite-PK `(id, user_id)`/`(key, user_id)` for default-data tables.
- **INV-47** `reconcileDefaults` runs AFTER `waitForInitialSync`.
- **INV-48** `defaultHash` is the modification tracker — `update*` strips it; `reset*ToDefault` recomputes.

## Backend Skeleton
- **INV-49** Single Elysia tree at `/v1`; Better Auth uses `.all('/*')` not `.mount()` (mount bypasses rate limiting).
- **INV-50** `safeErrorHandler` re-applied per plugin (Elysia confines `onError`).
- **INV-51** Error envelope always `{success:false, data:null, error:reasonPhrase}`; internals never leak.
- **INV-52** Domain error codes returned, not thrown (bypass `safeErrorHandler`).
- **INV-53** PGLite default driver; Postgres only when `DATABASE_DRIVER=postgres`.
- **INV-54** `runMigrations()` before `createApp`; discovered via `process.cwd()/drizzle`.
- **INV-55** Migration `_journal.json` MUST include new entries (else migration never runs).
- **INV-56** CORS allowed headers must include any new custom request header (else preflight fails silently). Browser-readable response headers go in `corsExposeHeaders`.
- **INV-57** Settings parsed once + cached (`clearSettingsCache()` for tests).
- **INV-58** Trusted proxy headers: `cf-connecting-ip`/`true-client-ip` only; XFF/Forwarded never trusted.
- **INV-59** Rate-limit table shared across tiers; key prefix discriminates.
- **INV-60** User-keyed rate limit must be `.use()`d INSIDE `guard({auth:true})`.
- **INV-61** IP-keyed rate limit skips `'unknown'`.

## AI / Chat / MCP
- **INV-62** User's outbound message persisted before model invoked (crash-safe).
- **INV-63** Partial assistant messages persisted ≤ every 200ms while streaming.
- **INV-64** `stepCountIs(maxSteps)` is the only stop condition; final-step nudge disables tools.
- **INV-65** Backend `/v1/inference/*` only accepts `stream:true`; privileged roles after `messages[0]` downgraded to user.
- **INV-66** MCP traffic rides universal proxy `/v1/proxy`; proxy hop authed with session bearer, upstream MCP cred rides as `X-Proxy-Passthrough-Authorization`.
- **INV-67** PostHog `privacy_mode===true` when configured; conversation content never in `$ai_input`/`$ai_output`.
- **INV-68** MCP server config AND credentials are local-only (never synced/E2EE'd); `mcp_secrets` is bearer|oauth union.
- **INV-69** Encryption mismatch fatal — `chatThread.isEncrypted !== selectedModel.isConfidential` throws synchronously.
- **INV-70** Widget tags must be self-closing `<widget:name … />`; parser silently drops invalid widgets.

## Frontend Devices & Reset
- **INV-71** Single canonical reset: `clearLocalData()` → `window.location.replace(...)`.
- **INV-72** Current-device-revoked dual-tracked (`powersyncCredentialsInvalid` event + React Query watcher).
- **INV-73** Sign-in modal suppressed if revoked-modal already fired.
- **INV-74** `hadDeviceOnceRef` distinguishes first-load from post-deletion sync wipe.

## Tauri Shell
- **INV-75** Window hidden until React mounts (`visible:false`).
- **INV-76** Single instance per OS (focuses existing window).
- **INV-77** `tauri-plugin-http` capability gated by `native_fetch` flag.
- **INV-78** CSP `connect-src` explicit allow (backend 8000, Ollama 11434); `script-src 'self'`.
- **INV-79** Backend proxy CSP `sandbox` — every proxied response sets sandbox + `Content-Disposition: attachment` + `nosniff` + CORP.
- **INV-80** `createSafeFetch` IP-pins every redirect hop (DNS before connect; max 5 redirects).
