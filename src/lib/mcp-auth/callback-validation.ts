/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Pure validation of the OAuth authorization-response parameters returned to the
 * MCP OAuth callback, run BEFORE the token exchange. Two checks, both
 * assert-and-reject (a null/missing recorded value is a rejection, never a pass):
 *
 * - **CSRF nonce (RFC 6749 §10.12):** the returned `state` must equal the nonce
 *   we persisted before redirecting. A null/missing stored nonce is rejected
 *   (NOT short-circuited to accept), as is any mismatch.
 * - **Issuer (RFC 9207):** when the authorization server advertised
 *   `authorization_response_iss_parameter_supported`, the returned `iss` must be
 *   present and equal the issuer we discovered. We always reject a mismatch; we
 *   reject an absent `iss` only when the AS advertised the parameter.
 */
export type McpOAuthCallbackInput = {
  /** `state` echoed back by the authorization server. */
  returnedState: string | null | undefined
  /** `iss` echoed back by the authorization server (RFC 9207). */
  returnedIss: string | null | undefined
  /** CSRF nonce we persisted before redirecting. */
  storedNonce: string | null | undefined
  /** Issuer we discovered + recorded for this handshake. */
  storedIssuer: string | null | undefined
  /** Whether the AS metadata set `authorization_response_iss_parameter_supported`. */
  issParameterSupported: boolean
}

export type McpOAuthCallbackValidation = { ok: true } | { ok: false; reason: string }

/**
 * Validates the returned `state`/`iss` against the recorded handshake. Returns a
 * discriminated result so the caller can surface a friendly message and reject
 * before any token exchange. Never throws.
 */
export const validateMcpOAuthCallback = (input: McpOAuthCallbackInput): McpOAuthCallbackValidation => {
  const { returnedState, returnedIss, storedNonce, storedIssuer, issParameterSupported } = input

  if (!storedNonce) {
    return { ok: false, reason: 'Missing CSRF state — restart the authorization.' }
  }
  if (returnedState !== storedNonce) {
    return { ok: false, reason: 'OAuth state mismatch — possible CSRF, authorization rejected.' }
  }

  if (issParameterSupported && !returnedIss) {
    return { ok: false, reason: 'Authorization server omitted the required issuer (iss).' }
  }
  if (returnedIss && returnedIss !== storedIssuer) {
    return { ok: false, reason: 'OAuth issuer mismatch — authorization rejected.' }
  }

  return { ok: true }
}
