/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it } from 'bun:test'
import { clearMcpOAuthState, getMcpOAuthState, setMcpOAuthState } from './mcp-oauth-state'

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
})
