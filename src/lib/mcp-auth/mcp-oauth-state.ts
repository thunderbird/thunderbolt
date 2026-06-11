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
  /**
   * Authorization server discovered at the start of the flow, pinned so the
   * callback exchanges the code against the AS we actually authorized with —
   * never re-derived from the (now-untrusted) server URL after the redirect.
   */
  authorizationServerUrl: string | null
  /** Serialized AS metadata captured at start, reused verbatim for the token exchange. */
  metadata: string | null
  /**
   * Epoch ms when the flow began. Lets a new flow detect an abandoned in-flight
   * one (user closed the tab mid-consent) and replace it instead of being
   * blocked forever by the single-flight guard.
   */
  startedAt: number | null
}

const emptyState = (): McpOAuthState => ({
  serverId: null,
  serverUrl: null,
  codeVerifier: null,
  stateNonce: null,
  issuer: null,
  redirectUrl: null,
  clientInfo: null,
  authorizationServerUrl: null,
  metadata: null,
  startedAt: null,
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

/**
 * True when an OAuth callback's returned `state` belongs to the in-flight MCP
 * handshake. The shared OAuth callback routers (web `oauth-callback.tsx` and the
 * mobile deep link) use this to claim a callback for the MCP page by handshake
 * ownership — the MCP flow never writes the shared `oauth_flow_state`
 * return-context slot the integrations flow uses, so routing must not depend on
 * it. Per RFC 6749 §4.1.2.1 the AS echoes `state` on error redirects too, so this
 * covers both success and error callbacks; a missing/foreign `state` falls
 * through to the integrations routing.
 */
export const isMcpOAuthCallback = (returnedState: string | null | undefined): boolean => {
  if (!returnedState) {
    return false
  }
  return getMcpOAuthState().stateNonce === returnedState
}
