/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const storageKey = 'mcp_oauth_flow_state'

/**
 * MCP OAuth in-flight handshake stored in localStorage (device-local, never
 * synced) so it survives the full-page web redirect to the authorization server
 * and back. Mirrors the integration OAuth pattern (`src/lib/oauth-state.ts`).
 *
 * localStorage (not sessionStorage) because the redirect is a full-page
 * `window.location.assign` — a synchronous read/write avoids the flush race the
 * async sqlite settings table had, and on Tauri mobile the OS may terminate the
 * app while the user is in the system browser (sessionStorage would be wiped).
 *
 * Single-flight: mcp_secrets is per-server, so only one MCP OAuth flow can be in
 * progress at a time. The handshake is keyed by `serverId` (carried in the blob)
 * and cleared once the callback completes.
 */
export type McpOAuthState = {
  serverId: string | null
  serverUrl: string | null
  codeVerifier: string | null
  stateNonce: string | null
  issuer: string | null
  redirectUrl: string | null
  clientInfo: string | null
}

const emptyState = (): McpOAuthState => ({
  serverId: null,
  serverUrl: null,
  codeVerifier: null,
  stateNonce: null,
  issuer: null,
  redirectUrl: null,
  clientInfo: null,
})

/** Reads the in-flight MCP OAuth handshake. Absent fields come back as null. */
export const getMcpOAuthState = (): McpOAuthState => {
  const raw = localStorage.getItem(storageKey)
  if (!raw) {
    return emptyState()
  }
  try {
    return JSON.parse(raw) as McpOAuthState
  } catch {
    return emptyState()
  }
}

/** Persists (merges) the in-flight MCP OAuth handshake. Only provided fields are written. */
export const setMcpOAuthState = (update: Partial<McpOAuthState>): void => {
  const current = getMcpOAuthState()
  const merged = { ...current, ...update }
  localStorage.setItem(storageKey, JSON.stringify(merged))
}

/** Clears the in-flight MCP OAuth handshake (callback success, failure, or cancel). */
export const clearMcpOAuthState = (): void => {
  localStorage.removeItem(storageKey)
}
