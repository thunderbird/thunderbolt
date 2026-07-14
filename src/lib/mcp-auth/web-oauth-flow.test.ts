/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AuthorizationServerMetadata, OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js'
import { getMcpServerCredentials, setMcpServerCredentials } from '@/dal/mcp-secrets'
import { getDb } from '@/db/database'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import {
  classifyMcpServerAuth,
  completeMcpOAuthFlow,
  computeMcpOAuthRedirectUri,
  isOAuthServer,
  startMcpOAuthFlow,
  type PlatformDeps,
  type WebOAuthDeps,
} from './web-oauth-flow'
import type { LoopbackCallbackParams } from './mcp-oauth-loopback'
import { clearMcpOAuthState, getMcpOAuthState, setMcpOAuthState } from './mcp-oauth-state'

const serverId = 'srv-1'
const serverUrl = 'https://mcp.example.com'
const authServerUrl = 'https://auth.example.com'
const origin = 'https://app.example.com'

const noFetch = (async () => {
  throw new Error('fetch should not be called — SDK helpers are injected')
}) as never

// Default AS metadata advertises Dynamic Client Registration (the common case);
// token-only tests opt out with `registration_endpoint: undefined`.
const metadata = (overrides: Partial<AuthorizationServerMetadata> = {}): AuthorizationServerMetadata =>
  ({
    issuer: authServerUrl,
    authorization_endpoint: `${authServerUrl}/authorize`,
    token_endpoint: `${authServerUrl}/token`,
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
    registration_endpoint: `${authServerUrl}/register`,
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

// Bun runs test files in one worker, so a fresh pending handshake left in
// localStorage would leak into the next file and make isMcpOAuthCallback claim
// callbacks that aren't ours (e.g. the deep-link routing test). Clear it after
// every test so nothing escapes this file.
afterEach(() => {
  clearMcpOAuthState()
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

describe('classifyMcpServerAuth', () => {
  it("is 'authorizable' when the AS advertises a DCR registration endpoint", async () => {
    const result = await classifyMcpServerAuth(
      serverUrl,
      noFetch,
      happyDiscovery(metadata({ registration_endpoint: `${authServerUrl}/register` })),
    )
    expect(result).toBe('authorizable')
  })

  it("is 'token-only' when OAuth is advertised but the AS has no DCR and no CIMD (the GitHub case)", async () => {
    const result = await classifyMcpServerAuth(
      serverUrl,
      noFetch,
      happyDiscovery(metadata({ registration_endpoint: undefined })),
    )
    expect(result).toBe('token-only')
  })

  it("is 'authorizable' when the AS supports CIMD and a client-metadata document is available", async () => {
    const result = await classifyMcpServerAuth(
      serverUrl,
      noFetch,
      happyDiscovery(metadata({ client_id_metadata_document_supported: true })),
      true,
    )
    expect(result).toBe('authorizable')
  })

  it("is 'token-only' when the AS supports CIMD but no client-metadata document is available", async () => {
    const result = await classifyMcpServerAuth(
      serverUrl,
      noFetch,
      happyDiscovery(metadata({ client_id_metadata_document_supported: true, registration_endpoint: undefined })),
      false,
    )
    expect(result).toBe('token-only')
  })

  it("is 'none' when no protected-resource metadata is discoverable", async () => {
    const result = await classifyMcpServerAuth(serverUrl, noFetch, {
      discoverOAuthProtectedResourceMetadata: async () => {
        throw new Error('Resource server does not implement OAuth 2.0 Protected Resource Metadata.')
      },
    })
    expect(result).toBe('none')
  })

  it("is 'token-only' when PRM is advertised but the AS is unusable (issuer mismatch)", async () => {
    const result = await classifyMcpServerAuth(serverUrl, noFetch, {
      discoverOAuthProtectedResourceMetadata: async () =>
        ({ resource: serverUrl, authorization_servers: [authServerUrl] }) as never,
      discoverAuthorizationServerMetadata: async () => metadata({ issuer: 'https://evil.example.com' }),
    })
    expect(result).toBe('token-only')
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

  it('requests the resource-advertised scopes_supported on registration and authorization', async () => {
    const db = getDb()
    let registeredScope: string | undefined
    let authorizedScope: string | undefined

    await startMcpOAuthFlow(
      { db, serverId, serverUrl, fetchFn: noFetch, origin, isBackendConnected: () => false },
      {
        // A scope-gated resource (like Metabase) advertises the scopes its tools require.
        discoverOAuthProtectedResourceMetadata: async () =>
          ({
            resource: serverUrl,
            authorization_servers: [authServerUrl],
            scopes_supported: ['agent:query', 'agent:search'],
          }) as never,
        discoverAuthorizationServerMetadata: async () => metadata(),
        registerClient: async (_url, opts) => {
          registeredScope = opts.scope
          return { client_id: 'dcr-client', redirect_uris: [`${origin}/oauth/callback`] } as OAuthClientInformationFull
        },
        startAuthorization: async (_url, opts) => {
          authorizedScope = opts.scope
          return { authorizationUrl: new URL(`${authServerUrl}/authorize?x=1`), codeVerifier: 'verifier-1' }
        },
      },
    )

    // The advertised scopes are requested space-delimited on both the DCR registration
    // and the authorization request — without this a scope-gated server issues a token
    // authorized for nothing and tools/list comes back empty.
    expect(registeredScope).toBe('agent:query agent:search')
    expect(authorizedScope).toBe('agent:query agent:search')
  })

  it('omits scope when the resource advertises no scopes_supported (non-gated server)', async () => {
    const db = getDb()
    let authorizedScope: string | undefined = 'unset'

    await startMcpOAuthFlow(
      { db, serverId, serverUrl, fetchFn: noFetch, origin, isBackendConnected: () => false },
      {
        ...happyDiscovery(metadata()),
        registerClient: async () =>
          ({ client_id: 'dcr-client', redirect_uris: [`${origin}/oauth/callback`] }) as OAuthClientInformationFull,
        startAuthorization: async (_url, opts) => {
          authorizedScope = opts.scope
          return { authorizationUrl: new URL(`${authServerUrl}/authorize?x=1`), codeVerifier: 'verifier-1' }
        },
      },
    )

    expect(authorizedScope).toBeUndefined()
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

  it('rejects a token-only AS (no DCR, no CIMD) with an actionable message and never registers', async () => {
    const db = getDb()
    let registered = false
    await expect(
      startMcpOAuthFlow(
        { db, serverId, serverUrl, fetchFn: noFetch, origin, isBackendConnected: () => false },
        {
          ...happyDiscovery(metadata({ registration_endpoint: undefined })),
          registerClient: async () => {
            registered = true
            return { client_id: 'x' } as OAuthClientInformationFull
          },
        },
      ),
    ).rejects.toThrow(/personal access token/)
    // No client registration is attempted — the flow bails with the actionable hint.
    expect(registered).toBe(false)
  })

  it('clears the persisted handshake when the flow throws after writing it', async () => {
    const db = getDb()
    await expect(
      startMcpOAuthFlow(
        { db, serverId, serverUrl, fetchFn: noFetch, origin, isBackendConnected: () => false },
        {
          ...happyDiscovery(metadata()),
          registerClient: async () =>
            ({ client_id: 'dcr-client', redirect_uris: [`${origin}/oauth/callback`] }) as OAuthClientInformationFull,
          // The handshake is persisted just before this runs; its throw must not
          // leave a stale single-flight slot behind.
          startAuthorization: async () => {
            throw new Error('boom')
          },
        },
      ),
    ).rejects.toThrow('boom')

    // No leftover handshake to block another server for the abandoned-flow window.
    expect(getMcpOAuthState().serverId).toBeNull()
  })

  it('refuses to start while a fresh flow for a different server is pending', async () => {
    const db = getDb()
    // A flow for another server is mid-redirect (slot occupied, just started).
    setMcpOAuthState({ serverId: 'other-server', startedAt: Date.now() })

    await expect(
      startMcpOAuthFlow(
        { db, serverId, serverUrl, fetchFn: noFetch, origin, isBackendConnected: () => false },
        { ...happyDiscovery(metadata()) },
      ),
    ).rejects.toThrow(/already in progress/)

    // The pending flow's slot is untouched.
    expect(getMcpOAuthState().serverId).toBe('other-server')
  })

  it('allows restarting the same server while its flow is pending', async () => {
    const db = getDb()
    setMcpOAuthState({ serverId, startedAt: Date.now() })

    await startMcpOAuthFlow(
      { db, serverId, serverUrl, fetchFn: noFetch, origin, isBackendConnected: () => false },
      {
        ...happyDiscovery(metadata()),
        registerClient: async () =>
          ({ client_id: 'dcr-client', redirect_uris: [`${origin}/oauth/callback`] }) as OAuthClientInformationFull,
        startAuthorization: async () => ({
          authorizationUrl: new URL(`${authServerUrl}/authorize`),
          codeVerifier: 'verifier-1',
        }),
      },
    )

    expect(redirectedTo).toBe(`${authServerUrl}/authorize`)
  })

  it('replaces an abandoned (stale) pending flow for a different server', async () => {
    const db = getDb()
    // A different server's flow started long ago and was never completed.
    setMcpOAuthState({ serverId: 'other-server', startedAt: Date.now() - 11 * 60 * 1000 })

    await startMcpOAuthFlow(
      { db, serverId, serverUrl, fetchFn: noFetch, origin, isBackendConnected: () => false },
      {
        ...happyDiscovery(metadata()),
        registerClient: async () =>
          ({ client_id: 'dcr-client', redirect_uris: [`${origin}/oauth/callback`] }) as OAuthClientInformationFull,
        startAuthorization: async () => ({
          authorizationUrl: new URL(`${authServerUrl}/authorize`),
          codeVerifier: 'verifier-1',
        }),
      },
    )

    // The stale slot was overwritten by this server's fresh handshake.
    expect(getMcpOAuthState().serverId).toBe(serverId)
    expect(redirectedTo).toBe(`${authServerUrl}/authorize`)
  })
})

describe('completeMcpOAuthFlow', () => {
  beforeEach(async () => {
    await resetTestDatabase()
    localStorage.clear()
  })

  const pinnedMetadata = metadata({ authorization_response_iss_parameter_supported: true } as never)

  // Production handshake: the authorization server is pinned at start, so the
  // callback exchanges against it without re-discovering.
  const seedHandshake = () =>
    setMcpOAuthState({
      serverId,
      serverUrl,
      stateNonce: 'nonce-1',
      issuer: authServerUrl,
      codeVerifier: 'verifier-1',
      redirectUrl: `${origin}/oauth/callback`,
      clientInfo: JSON.stringify({ client_id: 'dcr-client' }),
      authorizationServerUrl: authServerUrl,
      metadata: JSON.stringify(pinnedMetadata),
    })

  // Handshake recorded before AS pinning existed: forces the re-discovery fallback.
  const seedLegacyHandshake = () =>
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

  it('reuses the pinned authorization server and never re-discovers it on callback', async () => {
    const db = getDb()
    seedHandshake()
    let exchangedAuthServer: string | URL | undefined

    await completeMcpOAuthFlow(
      { db, serverId, code: 'auth-code', returnedState: 'nonce-1', returnedIss: authServerUrl, fetchFn: noFetch },
      {
        // Re-discovery must NOT run on the pinned path — make it throw to prove it.
        discoverOAuthProtectedResourceMetadata: async () => {
          throw new Error('re-discovery must not run on the pinned path')
        },
        discoverAuthorizationServerMetadata: async () => {
          throw new Error('re-discovery must not run on the pinned path')
        },
        exchangeAuthorization: async (url) => {
          exchangedAuthServer = url
          return { access_token: 'access-1', token_type: 'Bearer' }
        },
      },
    )

    expect(String(exchangedAuthServer)).toBe(authServerUrl)
  })

  it('ignores a resource server that swaps its authorization server after the redirect', async () => {
    const db = getDb()
    seedHandshake()
    let exchangedAuthServer: string | URL | undefined

    // The server now advertises an attacker-controlled AS. The pinned path must
    // exchange against the AS captured at start, never the swapped one — otherwise
    // the code + PKCE verifier would be sent to the attacker's token endpoint.
    await completeMcpOAuthFlow(
      { db, serverId, code: 'auth-code', returnedState: 'nonce-1', returnedIss: authServerUrl, fetchFn: noFetch },
      {
        discoverOAuthProtectedResourceMetadata: async () =>
          ({ resource: serverUrl, authorization_servers: ['https://evil.example.com'] }) as never,
        discoverAuthorizationServerMetadata: async () =>
          metadata({
            issuer: 'https://evil.example.com',
            authorization_endpoint: 'https://evil.example.com/authorize',
            token_endpoint: 'https://evil.example.com/token',
          }),
        exchangeAuthorization: async (url) => {
          exchangedAuthServer = url
          return { access_token: 'access-1', token_type: 'Bearer' }
        },
      },
    )

    expect(String(exchangedAuthServer)).toBe(authServerUrl)
    const cred = await getMcpServerCredentials(db, serverId)
    expect(cred?.type === 'oauth' && cred.tokenEndpoint).toBe(`${authServerUrl}/token`)
  })

  it('falls back to discovery for a legacy handshake and rejects an issuer that drifts from start', async () => {
    const db = getDb()
    seedLegacyHandshake()
    let exchanged = false

    await expect(
      completeMcpOAuthFlow(
        { db, serverId, code: 'auth-code', returnedState: 'nonce-1', returnedIss: authServerUrl, fetchFn: noFetch },
        {
          discoverOAuthProtectedResourceMetadata: async () =>
            ({ resource: serverUrl, authorization_servers: ['https://evil.example.com'] }) as never,
          discoverAuthorizationServerMetadata: async () =>
            metadata({
              issuer: 'https://evil.example.com',
              authorization_endpoint: 'https://evil.example.com/authorize',
              token_endpoint: 'https://evil.example.com/token',
            }),
          exchangeAuthorization: async () => {
            exchanged = true
            return { access_token: 'x', token_type: 'Bearer' }
          },
        },
      ),
    ).rejects.toThrow(/changed between start and callback/)

    expect(exchanged).toBe(false)
  })
})

describe('computeMcpOAuthRedirectUri', () => {
  it('uses the app-origin callback route on web', () => {
    const uri = computeMcpOAuthRedirectUri(origin, { isTauri: () => false, isMobile: () => false })
    expect(uri).toBe(`${origin}/oauth/callback`)
  })

  it('uses the verified App Link on Tauri mobile', () => {
    const uri = computeMcpOAuthRedirectUri(origin, { isTauri: () => true, isMobile: () => true })
    expect(uri).toBe('https://app.thunderbolt.io/oauth/callback')
  })
})

describe('startMcpOAuthFlow — mobile', () => {
  beforeEach(async () => {
    await resetTestDatabase()
    localStorage.clear()
  })

  const mobilePlatform = (openUrl: PlatformDeps['openUrl']): PlatformDeps => ({
    isTauri: () => true,
    isMobile: () => true,
    openUrl,
  })

  it('opens the system browser (not the webview) with the app-link redirect URI and returns redirected', async () => {
    const db = getDb()
    let openedUrl: string | undefined
    let startedRedirect: string | URL | undefined

    const result = await startMcpOAuthFlow(
      { db, serverId, serverUrl, fetchFn: noFetch, origin, isBackendConnected: () => false },
      {
        ...happyDiscovery(metadata()),
        registerClient: async () =>
          ({
            client_id: 'dcr-client',
            redirect_uris: ['https://app.thunderbolt.io/oauth/callback'],
          }) as OAuthClientInformationFull,
        startAuthorization: async (_url, opts) => {
          startedRedirect = opts.redirectUrl
          return { authorizationUrl: new URL(`${authServerUrl}/authorize?x=1`), codeVerifier: 'verifier-1' }
        },
      },
      mobilePlatform(async (url: string | URL) => {
        openedUrl = String(url)
      }),
    )

    expect(result).toEqual({ status: 'redirected' })
    // The mobile app-link redirect URI is registered/authorized with.
    expect(String(startedRedirect)).toBe('https://app.thunderbolt.io/oauth/callback')
    // The system browser is opened — the webview is never navigated.
    expect(openedUrl).toBe(`${authServerUrl}/authorize?x=1`)
    // The handshake is persisted so the deep-link callback can complete it.
    const handshake = getMcpOAuthState()
    expect(handshake.serverId).toBe(serverId)
    expect(handshake.redirectUrl).toBe('https://app.thunderbolt.io/oauth/callback')
  })
})

describe('startMcpOAuthFlow — desktop loopback', () => {
  beforeEach(async () => {
    await resetTestDatabase()
    localStorage.clear()
  })

  const loopbackPort = 17421

  /**
   * Simulates the desktop loopback server: hands the localhost redirect URI to
   * `buildAuthorizationUrl` (which discovers + registers + persists the handshake
   * against it), then crafts the callback. `craftCallback` receives the persisted
   * `stateNonce` so a valid callback can echo the CSRF nonce the flow just stored.
   */
  const desktopPlatform = (
    craftCallback: (stateNonce: string | null) => LoopbackCallbackParams | null,
  ): PlatformDeps => ({
    isTauri: () => true,
    isMobile: () => false,
    startMcpOAuthLoopback: async ({ buildAuthorizationUrl }) => {
      await buildAuthorizationUrl(`http://localhost:${loopbackPort}`)
      return craftCallback(getMcpOAuthState().stateNonce)
    },
  })

  it('registers DCR against the loopback URI, persists the pinned handshake, completes inline, and returns completed', async () => {
    const db = getDb()
    let registeredRedirect: string | undefined
    let exchangedRedirectUri: string | URL | undefined

    const result = await startMcpOAuthFlow(
      { db, serverId, serverUrl, fetchFn: noFetch, origin, isBackendConnected: () => false },
      {
        ...happyDiscovery(metadata({ authorization_response_iss_parameter_supported: true } as never)),
        registerClient: async (_url, opts) => {
          registeredRedirect = opts.clientMetadata.redirect_uris[0] as string
          return {
            client_id: 'dcr-client',
            redirect_uris: opts.clientMetadata.redirect_uris,
          } as OAuthClientInformationFull
        },
        startAuthorization: async () => ({
          authorizationUrl: new URL(`${authServerUrl}/authorize`),
          codeVerifier: 'verifier-1',
        }),
        exchangeAuthorization: async (_url, opts) => {
          exchangedRedirectUri = opts.redirectUri
          return { access_token: 'access-1', token_type: 'Bearer', refresh_token: 'refresh-1', expires_in: 3600 }
        },
      },
      desktopPlatform((stateNonce) => ({
        code: 'auth-code',
        state: stateNonce,
        iss: authServerUrl,
        error: null,
      })),
    )

    expect(result).toEqual({ status: 'completed' })
    // DCR and the token exchange both used the loopback redirect URI — never the server URL.
    expect(registeredRedirect).toBe(`http://localhost:${loopbackPort}`)
    expect(String(exchangedRedirectUri)).toBe(`http://localhost:${loopbackPort}`)

    // Tokens persisted by the inline completeMcpOAuthFlow.
    const cred = await getMcpServerCredentials(db, serverId)
    expect(cred?.type).toBe('oauth')
    if (cred?.type === 'oauth') {
      expect(cred.access_token).toBe('access-1')
      expect(cred.refresh_token).toBe('refresh-1')
      expect(cred.clientId).toBe('dcr-client')
      expect(cred.issuer).toBe(authServerUrl)
    }

    // Handshake cleared by completeMcpOAuthFlow.
    expect(getMcpOAuthState().serverId).toBeNull()
  })

  it('throws and clears the handshake when the loopback times out', async () => {
    const db = getDb()

    await expect(
      startMcpOAuthFlow(
        { db, serverId, serverUrl, fetchFn: noFetch, origin, isBackendConnected: () => false },
        {
          ...happyDiscovery(metadata()),
          registerClient: async () =>
            ({
              client_id: 'dcr-client',
              redirect_uris: [`http://localhost:${loopbackPort}`],
            }) as OAuthClientInformationFull,
          startAuthorization: async () => ({
            authorizationUrl: new URL(`${authServerUrl}/authorize`),
            codeVerifier: 'verifier-1',
          }),
        },
        desktopPlatform(() => null),
      ),
    ).rejects.toThrow(/timed out/)

    // No stuck handshake blocks a retry.
    expect(getMcpOAuthState().serverId).toBeNull()
    // DCR ran, so the placeholder oauth blob (client_id, empty token) exists — but
    // no real access token was issued, exactly as in the web flow before callback.
    const cred = await getMcpServerCredentials(db, serverId)
    expect(cred?.type === 'oauth' && cred.access_token).toBe('')
  })

  it('surfaces an error returned by the loopback callback without exchanging', async () => {
    const db = getDb()
    let exchanged = false

    await expect(
      startMcpOAuthFlow(
        { db, serverId, serverUrl, fetchFn: noFetch, origin, isBackendConnected: () => false },
        {
          ...happyDiscovery(metadata()),
          registerClient: async () =>
            ({
              client_id: 'dcr-client',
              redirect_uris: [`http://localhost:${loopbackPort}`],
            }) as OAuthClientInformationFull,
          startAuthorization: async () => ({
            authorizationUrl: new URL(`${authServerUrl}/authorize`),
            codeVerifier: 'verifier-1',
          }),
          exchangeAuthorization: async () => {
            exchanged = true
            return { access_token: 'x', token_type: 'Bearer' }
          },
        },
        desktopPlatform(() => ({ code: null, state: null, iss: null, error: 'access_denied' })),
      ),
    ).rejects.toThrow(/access_denied/)

    expect(exchanged).toBe(false)
    expect(getMcpOAuthState().serverId).toBeNull()
  })
})
