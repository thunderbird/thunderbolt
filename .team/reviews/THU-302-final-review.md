# Final Code Review: THU-302 — In-house OAuth Loopback Server

**Date:** 2026-02-27
**Mode:** Report only (no files modified)
**Scope:** `origin/main...italomenezes/thu-302-02-wiring` (13 files, 484 insertions)
**PRs:** [#388](https://github.com/thunderbird/thunderbolt/pull/388) · [#389](https://github.com/thunderbird/thunderbolt/pull/389)

---

## Summary

Files reviewed: 13 | Issues found: 4 actionable (1 important, 3 suggestions) + 3 notes
Tier: Medium | Agent: Enhanced Code Reviewer (Sonnet 4.6)

The implementation is architecturally solid. The in-house Rust loopback server is clean (~153 lines), the TypeScript integration uses standard Tauri APIs (`invoke` + `listen`), and the stacked PR structure is correct. One piece of dead code should be cleaned up before merge; the rest are documentation and hardening suggestions.

---

## Important — Fix before merge

### 1. Duplicate re-entry guard in `use-oauth-connect.ts` — dead code

**File:** `src/hooks/use-oauth-connect.ts`, lines 184 and 214
**Confidence:** 85

There are two `loopbackActiveRef.current` checks:

```typescript
// Line 184 — top of connect(), before startConnecting()
if (isTauri() && !isMobile() && loopbackActiveRef.current) return

// Line 214 — inside the desktop else branch
if (loopbackActiveRef.current) return
loopbackActiveRef.current = true
```

The second check is **unreachable**: if the ref is `true`, line 184 already returned. If the ref is `false`, the second check is a no-op. The `else` branch is only entered when `isTauri() && !isMobile()` is already true, so the conditions are identical.

Additionally, `loopbackActiveRef.current = true` is set on line 215 (after `startConnecting`), leaving a theoretical gap where a second call could pass the first guard. JavaScript is single-threaded so this can't happen in practice, but the intent is clearer with the ref set immediately after the guard.

**Fix:** Remove the second guard (line 214) and move `loopbackActiveRef.current = true` to right after line 184:

```typescript
const connect = async (provider: OAuthProvider) => {
  setError(null)
  const key = connectingKey ?? provider

  if (isTauri() && !isMobile() && loopbackActiveRef.current) return
  loopbackActiveRef.current = true    // set immediately, before any async work

  startConnecting(key)

  try {
    if (isTauri()) {
      if (isMobile()) {
        // mobile path unchanged — reset ref since we're not using loopback
        loopbackActiveRef.current = false
        // ...
      } else {
        // desktop: loopback flow (ref already set)
        try {
          const result = await startLoopback(provider)
          // ...
        } finally {
          loopbackActiveRef.current = false
        }
      }
    } else {
      // web path — reset ref
      loopbackActiveRef.current = false
      // ...
    }
  } catch (e: unknown) {
    loopbackActiveRef.current = false
    // ...
  }
}
```

Or simpler — keep the guard at line 184 and move `loopbackActiveRef.current = true` to right after it, removing line 214 entirely. The `finally` block on line 229 handles the reset.

---

## Suggestions — Worth considering

### 2. Timeout distinguished by fragile string comparison

**File:** `src/lib/oauth-loopback.ts`, lines 55 and 75
**Confidence:** 80 | **Status:** Known (open thread on PR #388)

```typescript
setTimeout(() => reject(new Error('OAuth flow timed out')), timeoutMs)
// ...
if (err instanceof Error && err.message === 'OAuth flow timed out') return null
```

The string `'OAuth flow timed out'` is the sole coupling between the timeout creator (line 55) and the handler (line 75). A refactor that changes either string silently breaks the match. A `Symbol` sentinel or custom error class (`class OAuthTimeoutError extends Error {}`) would be more robust.

### 3. No documentation of the localhost hijack attack surface

**File:** `src-tauri/src/oauth_server.rs`, lines 69-86
**Confidence:** 75

The server accepts the first TCP connection with no validation. A local process could race to connect before the browser redirect arrives. This is a **known and accepted risk** for all loopback OAuth flows — PKCE mitigates it because the attacker doesn't have the code verifier. However, the code has no comment acknowledging this. Adding a brief security note (e.g., "Security: PKCE prevents token theft even if a local process connects first — see RFC 8252 §8.3") would help future reviewers understand this is intentional, not an oversight.

### 4. `invoke('start_oauth_server')` outside `try` — Rust thread leaks if `listen()` throws

**File:** `src/lib/oauth-loopback.ts`, lines 36-38
**Confidence:** 72

If `invoke` succeeds (Rust server binds to a port) but `listen()` subsequently throws (Tauri IPC failure), the Rust thread blocks on `accept()` indefinitely — no connection will ever arrive, and there's no cancel mechanism. The port stays occupied for the app's lifetime.

In practice this is extremely unlikely (Tauri IPC failing after `invoke` succeeded would indicate a systemic problem), and the thread dies when the app exits. Per CLAUDE.md's "prefer optimistic code" principle, this is an accepted risk. A timeout on the Rust `accept()` would be the proper fix but adds complexity.

---

## Notes — Informational, no action needed

### `OAuthUserInfo` type alias

`src/lib/auth.ts:34` — `export type OAuthUserInfo = GoogleUserInfo` was a deliberate choice to rename the type at the provider-agnostic boundary. It works correctly via structural subtyping. The JSDoc could be more explicit that it's currently backed by `GoogleUserInfo`, but this was already discussed and accepted.

### `openUrl` exposes OAuth URL to system shell

`src/lib/oauth-loopback.ts:52` — Standard industry pattern for all desktop OAuth implementations. The URL contains the state nonce and client_id but no credentials. Accepted.

### Single `read()` call on the TCP stream

`src-tauri/src/oauth_server.rs:75` — A single `stream.read()` may theoretically not deliver the full HTTP request. On localhost/loopback this is extremely reliable (TCP segments are not fragmented on loopback). Not worth a read loop for a single-request server.

---

## Privacy Concerns

None. No tokens, codes, credentials, or PII appear in logs or error messages. The OAuth error descriptions surfaced from provider callbacks are intentionally human-readable.

---

## What changed (full file inventory)

| File | Layer | Change |
|---|---|---|
| `src-tauri/src/oauth_server.rs` | 1 | **NEW** — ~153 lines Rust, raw `TcpListener`, zero deps |
| `src-tauri/src/commands.rs` | 1 | Added `start_oauth_server` command |
| `src-tauri/src/lib.rs` | 1 | Added `mod oauth_server`, registered command |
| `src/lib/oauth-loopback.ts` | 1 | **NEW** — `invoke` + `listen` flow replacing plugin |
| `src/lib/oauth-loopback.test.ts` | 1 | **NEW** — 7 unit tests |
| `src/integrations/google/auth.ts` | 1 | Optional `redirectUri?` on `buildAuthUrl` + `exchangeCodeForTokens` |
| `src/integrations/microsoft/auth.ts` | 1 | Same |
| `src/lib/auth.ts` | 1 | `OAuthUserInfo` type alias + `redirectUri?` wrappers + JSDoc |
| `src/hooks/use-oauth-connect.ts` | 2 | Import swap + re-entry guard via `loopbackActiveRef` |
| `src/hooks/use-oauth-connect.test.tsx` | 2 | Mock rename |
| `src/lib/oauth-webview.ts` | 2 | **DELETED** |
| `src-tauri/capabilities/auth.json` | 2 | **DELETED** |
| `src-tauri/capabilities/default.json` | 2 | Removed `core:webview:allow-create-webview-window` |

## What was removed (vs. plugin approach)

- `tauri-plugin-oauth` Rust crate
- `@fabianlars/tauri-plugin-oauth` npm package
- `oauth:allow-start` / `oauth:allow-cancel` Tauri capabilities
- `.plugin(tauri_plugin_oauth::init())` in `lib.rs`
- The plugin's two-phase JS injection URL capture mechanism

## What was added instead

- `oauth_server.rs` — ~153 lines of `std::net::TcpListener`, fully owned by the team
- `start_oauth_server` Tauri command — no plugin permissions needed
