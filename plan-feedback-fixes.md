# Plan: Address PR Feedback — THU-348 MCP Support

## Overview

This plan addresses the valid findings from the PR review feedback. Organized by workstream, each section lists what changes, where, and why.

---

## Workstream 1: Discriminated Union for `McpTransportConfig` (#5)

**Why:** Raí's suggestion eliminates non-null assertions and makes impossible states unrepresentable.

**Change:**
```typescript
// Before
type McpTransportConfig = {
  type: McpTransportType
  url?: string
  command?: string
  args?: string[]
}

// After
type McpTransportConfig =
  | { type: 'http' | 'sse'; url: string }
  | { type: 'stdio'; command: string; args?: string[] }
```

**Files affected (3):**

| File | Change |
|------|--------|
| `src/types/mcp.ts` | Replace flat type with discriminated union. Keep `McpTransportType` as derived: `McpTransportConfig['type']` |
| `src/lib/mcp-transports/transport-factory.ts` | Remove 3 `!` assertions — TypeScript narrowing handles them |
| `src/hooks/use-mcp-sync.tsx` | Branch on `dbServer.type` to construct the correct union variant |

**No changes needed:** `use-mcp-server-form.ts` (form state stays flat), `mcp-servers.tsx`, `mcp-provider.tsx`, `mcp-utils.ts`, DAL files.

---

## Workstream 2: Credential Store Refactor (#2, #6, #22)

**Why:** Raí flagged that PowerSync doesn't support local-only columns — only local-only tables. Chris wants alignment with e2ee. The existing `getDeviceId` in `auth-token.ts` can be reused.

### 2a: Create local-only `mcp_credentials` table

**Files:**

| File | Change |
|------|--------|
| `src/db/tables.ts` | Add `mcpCredentialsTable` (id, encryptedCredential). Remove `encryptedCredential` and `oauthAccountId` columns from `mcpServersTable` |
| `src/db/powersync/schema.ts` | Register `mcp_credentials` with `localOnly: true` |
| `powersync-service/config/config.yaml` | Revert to `SELECT *` for `mcp_servers` (no column exclusion needed) |

**Note:** `shared/powersync-tables.ts` does NOT need an entry — local-only tables aren't synced.

### 2b: Reuse `getDeviceId` from `auth-token.ts`

**Files:**

| File | Change |
|------|--------|
| `src/lib/mcp-auth/credential-store.ts` | Replace Tauri FS-based `getDeviceId` with `import { getDeviceId } from '@/lib/auth-token'`. Remove `@tauri-apps/plugin-fs` dependency entirely. Update all DB queries to use `mcpCredentialsTable` instead of `mcpServersTable.encryptedCredential` |
| `src/lib/mcp-auth/credential-store.test.ts` | Replace `mock.module('@tauri-apps/plugin-fs')` with `mock.module('@/lib/auth-token')` returning a stable test ID |

**Trade-off:** If localStorage is cleared (sign-out), the encryption key changes and stored credentials become unreadable. But since `mcp_credentials` is local-only, a full reset would also wipe the table — both are lost together, which is acceptable.

### 2c: Keep AES-GCM encryption (independent of e2ee)

No change to encryption approach. Raí's e2ee encrypts synced data via a shared Content Key. MCP credentials are local-only — e2ee doesn't cover them. Our PBKDF2 + AES-GCM with device-derived key is the right approach for local-only encryption-at-rest.

---

## Workstream 3: Minor Code Quality Fixes

### 3a: `isValid` useCallback deps (#9)

| File | Change |
|------|--------|
| `src/hooks/use-mcp-server-form.ts` | Narrow deps from `[state]` to `[state.transportType, state.command, state.args, state.url]` |

### 3b: `SET_COMMAND` and `SET_ARGS` reset connection state (#10)

| File | Change |
|------|--------|
| `src/hooks/use-mcp-server-form.ts` | Add `connectionStatus: 'idle', connectionError: null, serverCapabilities: []` to `SET_COMMAND` and `SET_ARGS` cases |

### 3c: Double-start guard for stdio transport (#4)

| File | Change |
|------|--------|
| `src/lib/mcp-transports/tauri-stdio-transport.ts` | Add `if (this.child) { return }` at start of `start()` |

### 3d: Import shared types in DAL (#13)

| File | Change |
|------|--------|
| `src/dal/mcp-servers.ts` | Import `McpTransportType`, `McpAuthType` from `@/types/mcp` instead of inline string unions |

### 3e: Remove dead code (#14, #16)

| File | Change |
|------|--------|
| `src/lib/mcp-provider.tsx` | Remove `export type { McpClient as MCPClient }` re-export |
| `src/dal/mcp-servers.ts` + `src/dal/index.ts` | Remove `updateMcpServerAuth` (unused, add back when OAuth is wired) |

### 3f: Guard `JSON.parse` on `dbServer.args` (#17)

| File | Change |
|------|--------|
| `src/hooks/use-mcp-sync.tsx` | Wrap `JSON.parse(dbServer.args)` in try/catch, fall back to empty array on parse failure |

### 3g: Dead `native_fetch` feature flag (#1)

| File | Change |
|------|--------|
| `src-tauri/Cargo.toml` | Remove `native_fetch = []` from `[features]` |

### 3h: Pin shell plugin version (#20)

| File | Change |
|------|--------|
| `src-tauri/Cargo.toml` | Change `tauri-plugin-shell = "2"` to `tauri-plugin-shell = "2.3"` |

### 3i: useReducer for page state (#11)

| File | Change |
|------|--------|
| `src/settings/use-mcp-servers-page.ts` | Consolidate 5 `useState` hooks into `useReducer` per CLAUDE.md |

### 3j: Eye icon toggle for bearer token (#12)

| File | Change |
|------|--------|
| `src/settings/add-mcp-server-dialog.tsx` | Add visibility toggle button next to the password input |

---

## Workstream 4: CIMD Domain Configuration (#23)

**Why:** Self-hosted deployments use different domains. Hardcoding `thunderbolt.io` breaks them.

| File | Change |
|------|--------|
| `src/lib/mcp-auth/oauth-client-provider.ts` | Read CIMD domain from `VITE_THUNDERBOLT_DOMAIN` env var, fall back to `thunderbolt.io` |
| `.env.example` | Add `VITE_THUNDERBOLT_DOMAIN=thunderbolt.io` with comment |
| `docs/self-hosting.md` or relevant doc | Document the env var for self-hosted deployments |

---

## Workstream 5: Render Tool Execution Bug (#26)

**Root cause:** Race condition. `addServerMutation` saves the DB row first, PowerSync reacts immediately and triggers `useMcpSync` which creates the transport. But `credentialStore.save()` hasn't written the encrypted bearer token yet — so the transport connects without auth. Tools list (from the test connection) but tool execution fails because the live client has no auth.

**Fix:**

| File | Change |
|------|--------|
| `src/settings/use-mcp-servers-page.ts` | Save the encrypted credential BEFORE inserting the DB row, not after. Or: save the credential in the same mutation as the DB insert, so `encryptedCredential` is present in the row when PowerSync fires |

**Proposed approach:** Write the encrypted credential directly into the `mcp_credentials` local-only table (from Workstream 2) in the mutation, then insert the `mcp_servers` row. Since `useMcpSync` reads `mcp_credentials` when building the `McpServerConfig`, the credential will be present when the transport is created.

**Validation:** After the fix, test on desktop:
1. Add Render MCP with bearer token
2. Verify tools list AND execute
3. Verify the bearer token survives app restart (re-read from encrypted store)

---

## Workstream 6: CORS Proxy for Web (#27)

**Why:** Remote MCP servers don't set CORS headers. The Tauri HTTP plugin bypasses CORS on desktop/mobile, but the web version uses browser fetch. Chris suggests using the existing backend proxy pattern.

### 6a: Backend — MCP Proxy Route

New Elysia route at `/v1/mcp-proxy`:

| Method | Behavior |
|--------|----------|
| `POST` | Forwards JSON-RPC body to target MCP server (URL from `X-Mcp-Target-Url` header). Returns JSON or SSE stream. |
| `GET` | SSE stream forwarding for server notifications |
| `DELETE` | Session termination forwarding |

Headers forwarded bidirectionally: `Mcp-Session-Id`, `Authorization`, `Content-Type`, `Accept`, `Last-Event-ID`.

SSRF protection via existing `validateSafeUrl()`. Behind auth middleware.

**Files:**

| File | Change |
|------|--------|
| `backend/src/mcp/proxy.ts` | NEW — MCP proxy route handlers |
| `backend/src/mcp/proxy.test.ts` | NEW — tests |
| `backend/src/index.ts` | Mount `/v1/mcp-proxy` route |
| `backend/src/config/settings.ts` | Add `X-Mcp-Target-Url` to `corsAllowHeaders` |

### 6b: Frontend — Proxy-Aware Transport

**Files:**

| File | Change |
|------|--------|
| `src/lib/mcp-transports/proxy-fetch.ts` | NEW — `createProxyFetch(cloudUrl, targetUrl)` that rewrites fetch to go through backend proxy |
| `src/lib/mcp-transports/transport-factory.ts` | Add third branch: `if (!isTauri() && isRemoteUrl(url)) → use proxy fetch` |

**Transport decision tree:**
```
isTauri()?
  yes → createTauriHttpTransport (direct, CORS bypass)
  no  → isLocalhost(url)?
          yes → new StreamableHTTPClientTransport (direct, same-origin)
          no  → new StreamableHTTPClientTransport with createProxyFetch (via backend)
```

**Offline users not affected:** Localhost MCP servers always use direct browser fetch. The proxy is only for remote URLs on web.

### 6c: Ecosystem validation

This is the same pattern used by:
- **MCP Inspector** — local Express proxy for browser-to-remote MCP
- **Thunderbolt's existing proxy** — `/v1/pro/proxy/*` for link previews
- The MCP SDK's `fetch` injection point was designed for exactly this use case

---

## Workstream 7: SSE and stdio UX (#24)

**Chris's suggestion:** Remove SSE, show stdio as disabled on non-desktop.

**Proposed approach:**
- **Keep SSE** — deprecated per MCP spec but some servers still only support it. Removing breaks compatibility.
- **Show stdio on all platforms** but disabled on non-desktop with "(desktop app only)" label — users discover the feature exists

| File | Change |
|------|--------|
| `src/settings/add-mcp-server-dialog.tsx` | Show stdio option everywhere but `disabled` with "(desktop app only)" when `!isDesktop()` |

---

## Execution Order

The workstreams have dependencies:

```
Workstream 2 (credential store) must come before Workstream 5 (Render fix)
Workstream 1 (discriminated union) is independent
Workstream 3 (minor fixes) is independent
Workstream 4 (CIMD env var) is independent
Workstream 6 (CORS proxy) is independent but large
Workstream 7 (SSE/stdio UX) is independent
```

**Suggested priority:**
1. Workstream 3 (minor fixes) — quick wins, improves code quality
2. Workstream 1 (discriminated union) — small, high-value type safety
3. Workstream 2 (credential store refactor) — addresses multiple reviewer concerns
4. Workstream 5 (Render race condition) — blocks Chris's validation
5. Workstream 4 (CIMD env var) — quick, addresses self-hosted concern
6. Workstream 7 (SSE/stdio UX) — small UX improvement
7. Workstream 6 (CORS proxy) — largest workstream, can be a follow-up PR

---

## Items NOT addressed (per instructions)

- **#7** (hardcoded redirect_uris) — skipped
- **#18** (shell `args: true` security) — skipped
- **#25** (OAuth wiring) — deferred to future discussion
