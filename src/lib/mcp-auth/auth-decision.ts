/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { isUnauthorizedError } from '@/lib/mcp-errors'

/**
 * Industry-grounded MCP auth precedence (confirmed across Claude Code, Cline,
 * VS Code, and the MCP SDK). A bare 401 cannot itself distinguish "needs OAuth"
 * from "bad static token" — so the *user-supplied credential* takes precedence,
 * with OAuth discovery used only as the actionability check when no static
 * credential is present. These pure helpers encode that precedence so the page
 * (and tests) share one decision path.
 */

/** Outcome of the Add-dialog Test Connection probe. */
export type TestConnectionResult =
  | { kind: 'success'; tools: string[] }
  /** A 401 with a user-supplied credential: the static token was rejected. No
   *  Authorize affordance — the config is wrong, exactly like Claude Code/Cline. */
  | { kind: 'token-rejected' }
  /** A 401 with no credential and OAuth actionable (DCR/CIMD): offer "Add & Authorize". */
  | { kind: 'needs-oauth' }
  /** A 401 with no credential where the server advertises OAuth (PRM present) but
   *  the authorization server supports NEITHER Dynamic Client Registration NOR
   *  CIMD (e.g. GitHub) — the SDK can't obtain a client, so the user must supply a
   *  static token (PAT / API key) instead of an Authorize affordance. */
  | { kind: 'needs-token' }
  /** Anything else: a plain connection failure (incl. empty-cred 401 with no
   *  discoverable OAuth — "no supported auth"). */
  | { kind: 'error' }

/**
 * How a remote MCP server can authenticate, resolved by OAuth discovery on an
 * empty-credential 401:
 *  - `authorizable`: the authorization server supports a usable client-registration
 *    path (DCR or CIMD) → offer "Add & Authorize".
 *  - `token-only`: OAuth is advertised (PRM) but the AS supports no usable
 *    registration → the user must supply a static token (PAT / API key).
 *  - `none`: no OAuth discoverable → a plain connection failure.
 */
export type McpAuthActionability = 'authorizable' | 'token-only' | 'none'

/**
 * Decides the Test Connection outcome from the probe error and whether the user
 * supplied a credential. OAuth actionability (`oauthActionability`) is only
 * consulted on an empty-credential 401 — the caller skips the (network) discovery
 * probe otherwise. Pure: discovery is resolved by the caller and passed in.
 */
export const decideTestConnectionResult = (args: {
  hasCredential: boolean
  error: unknown
  oauthActionability: McpAuthActionability
}): TestConnectionResult => {
  const { hasCredential, error, oauthActionability } = args
  if (!isUnauthorizedError(error)) {
    return { kind: 'error' }
  }
  // Static config wins: a supplied credential that 401s is a rejected token,
  // never an Authorize prompt.
  if (hasCredential) {
    return { kind: 'token-rejected' }
  }
  if (oauthActionability === 'authorizable') {
    return { kind: 'needs-oauth' }
  }
  if (oauthActionability === 'token-only') {
    return { kind: 'needs-token' }
  }
  return { kind: 'error' }
}

/** The credential type stored for a server, as read from the mcp_secrets blob. */
export type StoredCredentialType = 'oauth' | 'bearer' | 'none'

/** Visible authorization state of a server card, derived from connection state. */
export type OAuthCardDecision =
  /** Connected with OAuth creds — show "Re-authorize". */
  | { phase: 'authorized' }
  /** 401 / refresh-failed where re-auth is the right action (oauth or no creds). */
  | { phase: 'needs-auth' }
  /** No OAuth affordance — let the generic connection-error display show
   *  (e.g. a bearer token the server rejected). */
  | { phase: 'none' }

/**
 * Derives a server card's authorization state by STORED credential type, applying
 * the conflation fix: a BEARER server that 401s is NOT "needs-auth" (the token was
 * rejected — show the generic connection error), whereas an OAuth server or a
 * no-credential server that 401s IS "needs-auth". `needsReauth` is the
 * refresh-failed (revoked/expired refresh token) signal, which always re-auths.
 */
export const deriveOAuthCardDecision = (args: {
  isConnected: boolean
  credentialType: StoredCredentialType
  error: unknown
  needsReauth: boolean
}): OAuthCardDecision => {
  const { isConnected, credentialType, error, needsReauth } = args

  if (isConnected) {
    return credentialType === 'oauth' ? { phase: 'authorized' } : { phase: 'none' }
  }

  // A failed token refresh always drops to a clean re-authorization.
  if (needsReauth) {
    return { phase: 'needs-auth' }
  }

  if (!isUnauthorizedError(error)) {
    return { phase: 'none' }
  }

  // Conflation fix: a rejected bearer token is a connection error, not needs-auth.
  if (credentialType === 'bearer') {
    return { phase: 'none' }
  }

  // OAuth creds (token expired/revoked) or no creds (OAuth-eligible by
  // precedence) → re-authorize.
  return { phase: 'needs-auth' }
}
