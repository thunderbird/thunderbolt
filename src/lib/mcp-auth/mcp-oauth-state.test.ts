/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it } from 'bun:test'
import { setOAuthState } from '@/lib/oauth-state'
import {
  abandonedFlowMs,
  clearMcpOAuthState,
  getMcpOAuthState,
  isMcpOAuthCallback,
  setMcpOAuthState,
} from './mcp-oauth-state'

const emptyHandshake = {
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
}

describe('MCP OAuth state', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns all-null when no handshake is persisted', () => {
    expect(getMcpOAuthState()).toEqual(emptyHandshake)
  })

  it('round-trips the full in-flight handshake across a (simulated) redirect', () => {
    const handshake = {
      serverId: 'server-1',
      serverUrl: 'https://mcp.example.com',
      codeVerifier: 'verifier-abc',
      stateNonce: 'nonce-xyz',
      issuer: 'https://auth.example.com',
      redirectUrl: 'https://app.example.com/oauth/callback',
      clientInfo: JSON.stringify({ client_id: 'client-123' }),
      authorizationServerUrl: 'https://auth.example.com',
      metadata: JSON.stringify({
        issuer: 'https://auth.example.com',
        token_endpoint: 'https://auth.example.com/token',
      }),
      startedAt: 1_700_000_000_000,
    }
    setMcpOAuthState(handshake)

    // Fresh read (mirrors reading back after the full-page redirect).
    expect(getMcpOAuthState()).toEqual(handshake)
  })

  it('merges partial updates without clobbering unset fields', () => {
    setMcpOAuthState({ serverId: 'server-1', stateNonce: 'nonce-1' })
    setMcpOAuthState({ codeVerifier: 'verifier-1' })

    const state = getMcpOAuthState()
    expect(state.serverId).toBe('server-1')
    expect(state.stateNonce).toBe('nonce-1')
    expect(state.codeVerifier).toBe('verifier-1')
  })

  it('clears every handshake field', () => {
    setMcpOAuthState({
      serverId: 'server-1',
      serverUrl: 'https://mcp.example.com',
      codeVerifier: 'verifier-abc',
      stateNonce: 'nonce-xyz',
      issuer: 'https://auth.example.com',
      redirectUrl: 'https://app.example.com/oauth/callback',
      clientInfo: '{}',
    })

    clearMcpOAuthState()

    expect(getMcpOAuthState()).toEqual(emptyHandshake)
  })

  it('returns all-null on corrupt JSON instead of throwing', () => {
    localStorage.setItem('mcp_oauth_flow_state', 'not-json{')
    expect(getMcpOAuthState()).toEqual(emptyHandshake)
  })

  describe('isMcpOAuthCallback', () => {
    const pendingHandshake = () =>
      setMcpOAuthState({ serverId: 'server-1', stateNonce: 'nonce-xyz', startedAt: Date.now() })

    it('claims a code callback whose state matches the pending handshake nonce', () => {
      pendingHandshake()
      expect(isMcpOAuthCallback({ code: 'auth-code', state: 'nonce-xyz', error: null })).toBe(true)
    })

    it('never claims a code callback with a non-matching state (code exchange stays nonce-gated)', () => {
      pendingHandshake()
      expect(isMcpOAuthCallback({ code: 'auth-code', state: 'a-different-nonce', error: null })).toBe(false)
      expect(isMcpOAuthCallback({ code: 'auth-code', state: null, error: null })).toBe(false)
      // Even when the AS (incorrectly) sends an error alongside a code.
      expect(isMcpOAuthCallback({ code: 'auth-code', state: null, error: 'server_error' })).toBe(false)
    })

    it('is false when no handshake is pending', () => {
      expect(isMcpOAuthCallback({ code: 'auth-code', state: 'nonce-xyz', error: null })).toBe(false)
    })

    it('claims an error callback without state while a fresh handshake is pending', () => {
      // RFC 6749 §4.1.2.1 says the AS must echo `state` on error redirects, but
      // non-compliant ASes exist — an unclaimed error would leave the handshake
      // pending and block other servers' authorizations.
      pendingHandshake()
      expect(isMcpOAuthCallback({ code: null, state: null, error: 'access_denied' })).toBe(true)
    })

    it('claims an error callback with a foreign state (matches neither flow) while a handshake is pending', () => {
      pendingHandshake()
      setOAuthState({ state: 'integrations-nonce' })
      expect(isMcpOAuthCallback({ code: null, state: 'unknown-nonce', error: 'access_denied' })).toBe(true)
    })

    it('does not claim an error callback when no handshake is pending', () => {
      expect(isMcpOAuthCallback({ code: null, state: null, error: 'access_denied' })).toBe(false)
    })

    it('does not claim an error callback belonging to the pending integrations flow', () => {
      pendingHandshake()
      setOAuthState({ state: 'integrations-nonce' })
      expect(isMcpOAuthCallback({ code: null, state: 'integrations-nonce', error: 'access_denied' })).toBe(false)
    })

    it('does not claim an error callback for a stale (abandoned) handshake', () => {
      setMcpOAuthState({
        serverId: 'server-1',
        stateNonce: 'nonce-xyz',
        startedAt: Date.now() - abandonedFlowMs - 1,
      })
      expect(isMcpOAuthCallback({ code: null, state: null, error: 'access_denied' })).toBe(false)
    })

    it('does not claim a callback with neither code nor error', () => {
      pendingHandshake()
      expect(isMcpOAuthCallback({ code: null, state: null, error: null })).toBe(false)
    })
  })
})
