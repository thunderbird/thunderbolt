/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AuthorizationServerMetadata, OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js'
import { getMcpServerCredentials, setMcpServerCredentials } from '@/dal/mcp-secrets'
import { getDb } from '@/db/database'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { completeMcpOAuthFlow, isOAuthServer, startMcpOAuthFlow, type WebOAuthDeps } from './web-oauth-flow'
import { getMcpOAuthState, setMcpOAuthState } from './mcp-oauth-state'

const serverId = 'srv-1'
const serverUrl = 'https://mcp.example.com'
const authServerUrl = 'https://auth.example.com'
const origin = 'https://app.example.com'

const noFetch = (async () => {
  throw new Error('fetch should not be called — SDK helpers are injected')
}) as never

const metadata = (overrides: Partial<AuthorizationServerMetadata> = {}): AuthorizationServerMetadata =>
  ({
    issuer: authServerUrl,
    authorization_endpoint: `${authServerUrl}/authorize`,
    token_endpoint: `${authServerUrl}/token`,
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
    ...overrides,
  }) as AuthorizationServerMetadata

const happyDiscovery = (
  md: AuthorizationServerMetadata,
): Pick<WebOAuthDeps, 'discoverOAuthProtectedResourceMetadata' | 'discoverAuthorizationServerMetadata'> => ({
  discoverOAuthProtectedResourceMetadata: async () =>
    ({ resource: serverUrl, authorization_servers: [authServerUrl] }) as never,
  discoverAuthorizationServerMetadata: async () => md,
})

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

describe('isOAuthServer', () => {
  it('is true when protected-resource metadata advertises an authorization server', async () => {
    const result = await isOAuthServer(serverUrl, noFetch, {
      discoverOAuthProtectedResourceMetadata: async () =>
        ({ resource: serverUrl, authorization_servers: [authServerUrl] }) as never,
    })
    expect(result).toBe(true)
  })

  it('is false when metadata is discoverable but advertises no authorization server', async () => {
    const result = await isOAuthServer(serverUrl, noFetch, {
      discoverOAuthProtectedResourceMetadata: async () => ({ resource: serverUrl }) as never,
    })
    expect(result).toBe(false)
  })

  it('is false when discovery throws (server does not implement PRM — SDK throws on 404)', async () => {
    const result = await isOAuthServer(serverUrl, noFetch, {
      discoverOAuthProtectedResourceMetadata: async () => {
        throw new Error('Resource server does not implement OAuth 2.0 Protected Resource Metadata.')
      },
    })
    expect(result).toBe(false)
  })
})

describe('startMcpOAuthFlow', () => {
  // Other suites replace window.location with a stub that lacks `assign`, and
  // happy-dom does not restore it across files. Pin a spy here so the redirect
  // step is deterministic regardless of test ordering (and assertable).
  let redirectedTo: string | undefined
  let originalAssign: typeof window.location.assign | undefined

  beforeEach(async () => {
    await resetTestDatabase()
    localStorage.clear()
    redirectedTo = undefined
    originalAssign = window.location.assign
    window.location.assign = ((url: string) => {
      redirectedTo = url
    }) as typeof window.location.assign
  })

  afterEach(() => {
    window.location.assign = originalAssign as typeof window.location.assign
  })

  it('discovers, registers (DCR), persists the handshake, and redirects', async () => {
    const db = getDb()
    let registeredWith: string | undefined
    let startedWith: { state?: string; redirectUrl: string | URL } | undefined

    await startMcpOAuthFlow(
      { db, serverId, serverUrl, fetchFn: noFetch, origin, isBackendConnected: () => false },
      {
        ...happyDiscovery(metadata()),
        registerClient: async (url) => {
          registeredWith = String(url)
          return { client_id: 'dcr-client', redirect_uris: [`${origin}/oauth/callback`] } as OAuthClientInformationFull
        },
        startAuthorization: async (_url, opts) => {
          startedWith = { state: opts.state, redirectUrl: opts.redirectUrl }
          return { authorizationUrl: new URL(`${authServerUrl}/authorize?x=1`), codeVerifier: 'verifier-1' }
        },
      },
    )

    expect(registeredWith).toBe(authServerUrl)
    // redirect_uri must be the registered app-origin callback, never the server URL.
    expect(String(startedWith?.redirectUrl)).toBe(`${origin}/oauth/callback`)

    const handshake = getMcpOAuthState()
    expect(handshake.serverId).toBe(serverId)
    expect(handshake.serverUrl).toBe(serverUrl)
    expect(handshake.issuer).toBe(authServerUrl)
    expect(handshake.codeVerifier).toBe('verifier-1')
    expect(handshake.stateNonce).toBeTruthy()
    // The persisted nonce is the one handed to startAuthorization.
    expect(startedWith?.state).toBe(handshake.stateNonce ?? undefined)
    expect(handshake.clientInfo ?? '').toContain('dcr-client')

    // DCR client_id is persisted per-AS into the oauth credential blob.
    const cred = await getMcpServerCredentials(db, serverId)
    expect(cred?.type).toBe('oauth')
    if (cred?.type === 'oauth') {
      expect(cred.clientId).toBe('dcr-client')
    }

    // The browser is redirected to the authorization URL after the handshake is saved.
    expect(redirectedTo).toBe(`${authServerUrl}/authorize?x=1`)
  })

  it('rejects an AS that does not advertise PKCE S256', async () => {
    const db = getDb()
    await expect(
      startMcpOAuthFlow(
        { db, serverId, serverUrl, fetchFn: noFetch, origin, isBackendConnected: () => false },
        { ...happyDiscovery(metadata({ code_challenge_methods_supported: ['plain'] })) },
      ),
    ).rejects.toThrow(/PKCE S256/)
  })

  it('rejects when no authorization server is advertised', async () => {
    const db = getDb()
    await expect(
      startMcpOAuthFlow(
        { db, serverId, serverUrl, fetchFn: noFetch, origin, isBackendConnected: () => false },
        {
          discoverOAuthProtectedResourceMetadata: async () => ({ resource: serverUrl }) as never,
        },
      ),
    ).rejects.toThrow(/authorization server/)
  })

  it('rejects an issuer that does not match the discovered AS URL', async () => {
    const db = getDb()
    await expect(
      startMcpOAuthFlow(
        { db, serverId, serverUrl, fetchFn: noFetch, origin, isBackendConnected: () => false },
        { ...happyDiscovery(metadata({ issuer: 'https://evil.example.com' })) },
      ),
    ).rejects.toThrow(/issuer mismatch/)
  })
})

describe('completeMcpOAuthFlow', () => {
  beforeEach(async () => {
    await resetTestDatabase()
    localStorage.clear()
  })

  const seedHandshake = () =>
    setMcpOAuthState({
      serverId,
      serverUrl,
      stateNonce: 'nonce-1',
      issuer: authServerUrl,
      codeVerifier: 'verifier-1',
      redirectUrl: `${origin}/oauth/callback`,
      clientInfo: JSON.stringify({ client_id: 'dcr-client' }),
    })

  it('exchanges the code, persists the oauth blob, and clears the handshake', async () => {
    const db = getDb()
    seedHandshake()

    let exchangedRedirectUri: string | URL | undefined
    let exchangedResource: URL | undefined

    await completeMcpOAuthFlow(
      { db, serverId, code: 'auth-code', returnedState: 'nonce-1', returnedIss: authServerUrl, fetchFn: noFetch },
      {
        ...happyDiscovery(metadata({ authorization_response_iss_parameter_supported: true } as never)),
        exchangeAuthorization: async (_url, opts) => {
          exchangedRedirectUri = opts.redirectUri
          exchangedResource = opts.resource
          return { access_token: 'access-1', token_type: 'Bearer', refresh_token: 'refresh-1', expires_in: 3600 }
        },
      },
    )

    // Registered redirect URI is used for exchange — never the MCP server URL.
    expect(String(exchangedRedirectUri)).toBe(`${origin}/oauth/callback`)
    expect(exchangedResource?.toString()).toBe(`${serverUrl}/`)

    const cred = await getMcpServerCredentials(db, serverId)
    expect(cred?.type).toBe('oauth')
    if (cred?.type === 'oauth') {
      expect(cred.access_token).toBe('access-1')
      expect(cred.refresh_token).toBe('refresh-1')
      expect(cred.clientId).toBe('dcr-client')
      expect(cred.issuer).toBe(authServerUrl)
      expect(cred.tokenEndpoint).toBe(`${authServerUrl}/token`)
      expect(cred.expires_at).toBeGreaterThan(Date.now())
    }

    // Handshake cleared on success.
    const handshake = getMcpOAuthState()
    expect(handshake.serverId).toBeNull()
  })

  it('clears the handshake before the token exchange (single-use, no replay)', async () => {
    const db = getDb()
    seedHandshake()

    let handshakeAtExchange: string | null = 'not-observed'
    await completeMcpOAuthFlow(
      { db, serverId, code: 'auth-code', returnedState: 'nonce-1', returnedIss: authServerUrl, fetchFn: noFetch },
      {
        ...happyDiscovery(metadata({ authorization_response_iss_parameter_supported: true } as never)),
        exchangeAuthorization: async () => {
          // By the time the network exchange runs the handshake is already gone,
          // so a concurrent callback can't replay the authorization code.
          handshakeAtExchange = getMcpOAuthState().serverId
          return { access_token: 'access-1', token_type: 'Bearer' }
        },
      },
    )

    expect(handshakeAtExchange).toBeNull()
  })

  it('rejects (and does not exchange) on a CSRF state mismatch', async () => {
    const db = getDb()
    seedHandshake()
    let exchanged = false

    await expect(
      completeMcpOAuthFlow(
        { db, serverId, code: 'auth-code', returnedState: 'attacker', returnedIss: authServerUrl, fetchFn: noFetch },
        {
          ...happyDiscovery(metadata()),
          exchangeAuthorization: async () => {
            exchanged = true
            return { access_token: 'x', token_type: 'Bearer' }
          },
        },
      ),
    ).rejects.toThrow(/state mismatch/)

    expect(exchanged).toBe(false)
    expect(await getMcpServerCredentials(db, serverId)).toBeNull()
    // Handshake cleared even on failure (no stuck state).
    expect(getMcpOAuthState().serverId).toBeNull()
  })

  it('rejects on an issuer mismatch (RFC 9207)', async () => {
    const db = getDb()
    seedHandshake()

    await expect(
      completeMcpOAuthFlow(
        {
          db,
          serverId,
          code: 'auth-code',
          returnedState: 'nonce-1',
          returnedIss: 'https://evil.example.com',
          fetchFn: noFetch,
        },
        { ...happyDiscovery(metadata()) },
      ),
    ).rejects.toThrow(/issuer mismatch/)
  })

  it('rejects when the callback does not match the pending server', async () => {
    const db = getDb()
    seedHandshake()

    await expect(
      completeMcpOAuthFlow(
        {
          db,
          serverId: 'other-server',
          code: 'c',
          returnedState: 'nonce-1',
          returnedIss: authServerUrl,
          fetchFn: noFetch,
        },
        { ...happyDiscovery(metadata()) },
      ),
    ).rejects.toThrow(/did not match/)
  })

  it('does not overwrite an existing credential when validation fails', async () => {
    const db = getDb()
    await setMcpServerCredentials(db, serverId, { type: 'bearer', token: 'keep-me' })
    seedHandshake()

    await expect(
      completeMcpOAuthFlow(
        { db, serverId, code: 'c', returnedState: 'wrong', returnedIss: authServerUrl, fetchFn: noFetch },
        { ...happyDiscovery(metadata()) },
      ),
    ).rejects.toThrow()

    const cred = await getMcpServerCredentials(db, serverId)
    expect(cred).toEqual({ type: 'bearer', token: 'keep-me' })
  })
})
