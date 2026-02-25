# Consensus Approval: PROPOSAL-001 — Fix Google Connect on Desktop (THU-302)

**Approved by:** Team Lead
**Date:** 2026-02-25
**Status:** APPROVED

---

## Decision

PROPOSAL-001 is approved for implementation. The architecture (RESEARCH-001) is sound, the contracts are precise, and the user stories are clear and testable. Several corrections to the proposal document are noted below — implementers must follow the contracts, not the proposal where they diverge.

---

## Final Approved Scope

### In Scope

| Item | Implementer |
|---|---|
| `bun add @fabianlars/tauri-plugin-oauth@latest` | TASK-001 |
| Create `src/lib/oauth-loopback.ts` | TASK-001 |
| Create `src/lib/oauth-loopback.test.ts` | TASK-001 |
| Update `src/integrations/google/auth.ts` (add `redirectUri?`) | TASK-002 |
| Update `src/integrations/microsoft/auth.ts` (add `redirectUri?`) | TASK-002 |
| Update `src/lib/auth.ts` (pass through `redirectUri?`) | TASK-002 |
| Update `src/hooks/use-oauth-connect.ts` (webview → loopback) | TASK-002 |
| Update `src/hooks/use-oauth-connect.test.tsx` (mock rename) | TASK-002 |
| Delete `src/lib/oauth-webview.ts` | TASK-002 |
| `src-tauri/Cargo.toml` — add `tauri-plugin-oauth = "2"` | TASK-002 |
| `src-tauri/src/lib.rs` — add `.plugin(tauri_plugin_oauth::init())` | TASK-002 |
| `src-tauri/capabilities/default.json` — add `oauth:allow-start`, `oauth:allow-cancel`; remove `core:webview:allow-create-webview-window` | TASK-002 |
| Delete `src-tauri/capabilities/auth.json` | TASK-002 |

### Out of Scope

| Item | Reason |
|---|---|
| `src/lib/oauth-redirect.ts` | No changes needed. The loopback flow constructs its own `redirectUri` dynamically and bypasses `getOAuthRedirectUri()` entirely. The proposal scope table is wrong on this point — do not touch this file. |
| Mobile flow | Uses `openUrl` + App Links/Universal Links; works correctly. |
| Backend changes | `/auth/google/exchange` and `/auth/microsoft/exchange` already accept `redirect_uri` in the body. |
| `http:allow` loopback entries in `default.json` | Not needed. The plugin's Rust thread captures the redirect internally; the app makes no HTTP calls to the loopback ports via `ky` or `fetch`. |
| Google Cloud Console configuration | Manual operational step; out of code scope. Must be completed before QA. |
| Microsoft Entra configuration | Same. |
| New UI components | No visual changes needed. |
| Timeout extension | Open question deferred. The existing 15-second `connectingTimeoutMs` applies. The 5-minute timeout in `oauth-loopback.ts` is an internal flow timeout, separate from the UI connecting state. |

---

## Corrections to PROPOSAL-001

These corrections must be applied by implementers. Where the proposal and the contracts disagree, the contracts are authoritative.

### CORRECTION 1 — Wrong API: `listen('oauth://url', ...)` must be `onUrl(callback)`

The proposal's code skeleton (Technical Design section, `oauth-loopback.ts`) uses:

```typescript
// WRONG — do not use this
import { listen } from '@tauri-apps/api/event'
listen<string>('oauth://url', (event) => { ... })
```

The correct API is:

```typescript
// CORRECT — use this
import { onUrl } from '@fabianlars/tauri-plugin-oauth'
const unlisten = await onUrl((url) => { ... })
```

`onUrl` is the plugin's typed wrapper. The plugin does not expose a raw Tauri event for consumers to `listen()` on. Using `listen('oauth://url', ...)` will not work. Follow the oauth-loopback.md contract exactly.

### CORRECTION 2 — Wrong permission: `oauth:default` does not exist

The proposal scope table lists:

> Add `oauth:default` permission

This is wrong. The plugin defines no `oauth:default` permission set. The correct entries to add to `src-tauri/capabilities/default.json` are:

```json
"oauth:allow-start",
"oauth:allow-cancel"
```

Using `oauth:default` will cause a Tauri build error. Follow the rust-tauri.md contract.

### CORRECTION 3 — `oauth-redirect.ts` is NOT in scope

The proposal scope table lists `src/lib/oauth-redirect.ts` as requiring changes. This is incorrect. The loopback flow constructs `redirectUri = \`http://localhost:${port}\`` directly from the allocated port and passes it explicitly to `buildAuthUrl` and `exchangeCodeForTokens`. `getOAuthRedirectUri()` is not called by the loopback flow. Do not modify `oauth-redirect.ts`.

### CORRECTION 4 — `redirectUri` format: use `http://localhost:` not `http://127.0.0.1:`

The proposal uses `http://127.0.0.1:${port}`. The authoritative value in the contracts is `http://localhost:${port}`. Use `localhost`. The Google Cloud Console registrations must use `http://localhost:17421`, `http://localhost:17422`, `http://localhost:17423`.

---

## Task Breakdown

### TASK-001: New Loopback Module (Implementer-1)

**Can start immediately. No dependencies on TASK-002.**

**Files to create:**
- `src/lib/oauth-loopback.ts`
- `src/lib/oauth-loopback.test.ts`

**Installation step:**
```bash
bun add @fabianlars/tauri-plugin-oauth@latest
```

**Implementation contract:** Follow `/Users/italo/DEV/Mozilla/thunderbolt/.team/contracts/oauth-loopback.md` precisely.

**Key implementation requirements:**
1. Import `onUrl` (not `listen`) from `@fabianlars/tauri-plugin-oauth`
2. Use `Promise.withResolvers<string>()` to create `urlPromise` / `resolveUrl`
3. Call `await onUrl((url) => resolveUrl(url))` and store the returned `unlisten` function BEFORE calling `openUrl`
4. Use `[17421, 17422, 17423]` as the ports array — no other value
5. `redirectUri` must be `\`http://localhost:${port}\``
6. Wrap the entire flow in `try { ... } finally { unlisten?.(); await cancel(port).catch(() => {}) }`
7. Timeout is 5 minutes (`5 * 60 * 1000` ms) via `Promise.race` against a rejection
8. Return `null` on timeout; throw on state mismatch, token exchange failure, or port binding failure
9. Include the `completionHtml` constant with a `<head>` element (required by plugin for script injection)

**Test cases required (contract: oauth-loopback.md, Test Strategy section):**

The Tauri IPC calls (`start`, `cancel`, `onUrl`, `openUrl`) must be mocked. The test file can import the module and mock the `@fabianlars/tauri-plugin-oauth` module and `@tauri-apps/plugin-opener`. Tests should cover:

| Test | What to verify |
|---|---|
| Happy path | `start` → port, `onUrl` → valid URL, tokens returned, `cancel(port)` called |
| State mismatch | Callback URL has wrong state, throws `'OAuth state mismatch'`, `cancel` called |
| OAuth error in callback | `?error=access_denied` in URL, throws, `cancel` called |
| Missing code and state | URL has neither; throws `'Missing code or state'`, `cancel` called |
| Port exhaustion | `start` throws; error propagates; `cancel` not called |
| Exchange error | `exchangeCodeForTokens` throws; `cancel` still called (finally) |
| Timeout | `onUrl` never fires within timeout; returns `null`; `cancel` called |

**Auth signature dependency:** `oauth-loopback.ts` imports `buildAuthUrl` and `exchangeCodeForTokens` from `./auth` with the new optional `redirectUri?` parameter. If TASK-002 is not yet merged, Implementer-1 can call these functions with the `redirectUri` argument and accept a TypeScript error on the call site until TASK-002 lands. Alternatively, implement after TASK-002 completes.

---

### TASK-002: All Modifications (Implementer-2)

**Can start immediately. No dependencies on TASK-001.**

**Files to modify:**

| File | Contract |
|---|---|
| `src/integrations/google/auth.ts` | auth-signatures.md |
| `src/integrations/microsoft/auth.ts` | auth-signatures.md |
| `src/lib/auth.ts` | auth-signatures.md |
| `src/hooks/use-oauth-connect.ts` | use-oauth-connect.md |
| `src/hooks/use-oauth-connect.test.tsx` | use-oauth-connect.md |
| `src-tauri/Cargo.toml` | rust-tauri.md |
| `src-tauri/src/lib.rs` | rust-tauri.md |
| `src-tauri/capabilities/default.json` | rust-tauri.md |

**Files to delete:**

| File | Contract |
|---|---|
| `src/lib/oauth-webview.ts` | rust-tauri.md |
| `src-tauri/capabilities/auth.json` | rust-tauri.md |

**Key implementation requirements:**

1. **Auth signature changes are purely additive** — add `redirectUri?: string` as the last parameter to `buildAuthUrl` and `exchangeCodeForTokens` in all three files. When `redirectUri` is provided, use it; when `undefined`, fall back to `config.redirectUri`. No existing call sites change.

2. **Hook changes are surgical** — rename `startOAuthFlowWebview` to `startOAuthFlowLoopback` in the import, the `OAuthDependencies` type, the destructuring, and the desktop branch comment. The logic structure is identical. Do not restructure the hook.

3. **Rust capabilities** — add ONLY `"oauth:allow-start"` and `"oauth:allow-cancel"` to `default.json`. Do NOT add `"oauth:default"`. Remove ONLY `core:webview:allow-create-webview-window`. Keep all other webview permissions (sidebar content preview requires them).

4. **`auth.json` deletion** — delete the file. There is no replacement. No capability file needs to reference `oauth-*` windows after this change.

5. **Rust verification** — after `Cargo.toml` and `lib.rs` changes, run `cargo check` in `src-tauri/` to confirm the dependency resolves and the plugin init compiles.

---

## Critical Implementation Notes

### 1. `onUrl` not `listen`

The plugin's callback API is `onUrl(callback)`, not `listen('oauth://url', handler)`. This is the most likely mistake an implementer will make from reading the proposal. The plugin handles its own event routing internally.

### 2. `oauth:allow-start` and `oauth:allow-cancel` individually

The plugin has no `oauth:default` permission set. The capabilities file must list both commands explicitly. Verified against the plugin's `permissions/autogenerated/` directory.

### 3. Listener registration before browser open

`await onUrl(...)` must complete and the `unlisten` function stored before `await openUrl(authUrl)` is called. This prevents a race condition where the browser redirects back before the listener is ready. The `Promise.withResolvers` pattern in the contract handles this correctly.

### 4. Port format: `http://localhost:${port}`

Both the `redirectUri` passed to `buildAuthUrl`/`exchangeCodeForTokens` and the Cloud Console registrations must use `http://localhost:` (not `http://127.0.0.1:`).

### 5. `cancel()` failure is silently swallowed

`await cancel(port).catch(() => {})` in the `finally` block. The server thread exits anyway when the single-request cycle completes. A failure from `cancel()` should not mask the original error or result.

### 6. `oauth-redirect.ts` is untouched

Do not modify `src/lib/oauth-redirect.ts`. The loopback flow never calls `getOAuthRedirectUri()`.

---

## Pre-Merge Checklist

Before merging either task, verify:

- [ ] `bun test src/lib/oauth-loopback.test.ts` passes (TASK-001)
- [ ] `bun test src/hooks/use-oauth-connect.test.tsx` passes (TASK-002)
- [ ] `bun test src/lib/oauth-redirect.test.ts` passes (no regressions; file was not changed)
- [ ] `bun test src/lib/pkce.test.ts` passes
- [ ] `cargo check` passes in `src-tauri/` (TASK-002)
- [ ] No TypeScript errors: `bun tsc --noEmit`
- [ ] No import of `startOAuthFlowWebview` anywhere in the codebase
- [ ] No import of `@/lib/oauth-webview` anywhere in the codebase
- [ ] `src-tauri/capabilities/auth.json` does not exist
- [ ] `src-tauri/capabilities/default.json` contains `oauth:allow-start` and `oauth:allow-cancel` and does NOT contain `oauth:default`
- [ ] QA confirms Google Cloud Console has `http://localhost:17421`, `http://localhost:17422`, `http://localhost:17423` registered
- [ ] Manual E2E: desktop Google connect succeeds on macOS
- [ ] Manual E2E: desktop Microsoft connect succeeds on macOS
- [ ] Manual E2E: mobile Google connect unchanged (regression)
- [ ] Manual E2E: web Google connect unchanged (regression)
