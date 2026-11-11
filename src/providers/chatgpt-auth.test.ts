/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { beforeAll, beforeEach, afterEach, afterAll, expect, test, mock, spyOn } from 'bun:test'
import { exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet } from 'jose'
import { fetchProviderModels } from './models'
import type { OpenRouterAuthDependencies } from '@/lib/openrouter-auth'
import { eq } from 'drizzle-orm'
import { providerConnectionSecretsTable as secrets } from '@/db/tables'
import { getProviderConnectionRevision } from './revision'
import { listChatGPTAccounts, writeChatGPTRegistration } from './chatgpt-registration'
import * as session from './oauth-session'
import { http } from '@/lib/http'
import { getDb } from '@/db/database'
import { resetTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { stubJsonResponse } from '@/test-utils/http'
import {
  saveProviderConnection,
  disconnectProviderConnection,
  getProviderConnection,
  getProviderCredentials,
  deleteProviderConnection,
} from '@/dal/provider-connections'
import {
  validateChatGPTIdentity,
  connectChatGPT,
  readChatGPTRegistration,
  discardChatGPTAuthorization,
  ChatGPTCleanupError,
} from './chatgpt-auth'

beforeEach(async () => {
  await resetTestDatabase()
  spyOn(session, 'withProviderOAuthLock').mockImplementation(async (_id, work) => work())
})
afterEach(() => mock.restore())
afterAll(teardownTestDatabase)

let keys: Awaited<ReturnType<typeof generateKeyPair>>
let jwks: JSONWebKeySet
beforeAll(async () => {
  keys = await generateKeyPair('RS256')
  jwks = { keys: [await exportJWK(keys.publicKey)] }
})
const token = (overrides: Record<string, unknown> = {}) =>
  new SignJWT({
    iss: 'https://auth.openai.com',
    aud: 'issued-client',
    sub: 'account',
    nonce: 'nonce',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
    ...overrides,
  })
    .setProtectedHeader({ alg: 'RS256' })
    .sign(keys.privateKey)

test('accepts a signed identity with explicit plan-use consent', async () => {
  expect(await validateChatGPTIdentity(await token(), jwks, 'issued-client', 'nonce')).toMatchObject({
    subject: 'account',
  })
})

test.each([{ iss: 'https://other.example' }, { aud: 'another-client' }, { nonce: 'wrong' }, { exp: 1 }, { sub: '' }])(
  'rejects invalid identity claims %j',
  async (overrides) => {
    await expect(validateChatGPTIdentity(await token(overrides), jwks, 'issued-client', 'nonce')).rejects.toThrow()
  },
)

test('rejects account changes and untrusted signatures', async () => {
  const signed = await token()
  await expect(validateChatGPTIdentity(signed, jwks, 'issued-client', 'nonce', 'another-account')).rejects.toThrow(
    'did not match',
  )
  const other = await generateKeyPair('RS256')
  await expect(
    validateChatGPTIdentity(signed, { keys: [await exportJWK(other.publicKey)] }, 'issued-client', 'nonce'),
  ).rejects.toThrow()
})

test('registers an OSS client with PKCE and a loopback callback, then exchanges and validates the identity', async () => {
  const metadata = {
    issuer: 'https://auth.openai.com',
    authorization_endpoint: 'https://auth.openai.com/authorize',
    token_endpoint: 'https://auth.openai.com/api/accounts/oauth/token',
    jwks_uri: 'https://auth.openai.com/jwks',
    revocation_endpoint: 'https://auth.openai.com/revoke',
  }
  const get = spyOn(http, 'get').mockImplementation((url) =>
    stubJsonResponse(String(url).endsWith('/jwks') ? jwks : metadata),
  )
  const post = spyOn(http, 'post')
  let callback = (_url: string) => {}
  const credentials = await connectChatGPT(getDb(), new AbortController().signal, {
    isTauri: () => true,
    isMobile: () => false,
    startLoopback: async () => 12345,
    stopLoopback: async () => {},
    listenForLoopback: async (listener) => {
      callback = listener
      return () => {}
    },
    openExternalUrl: async (value) => {
      const url = new URL(value)
      expect(url.searchParams.get('client_id')).toBe('dynamic_agent_client')
      expect(url.searchParams.get('agent_name_hint')).toBe('Thunderbolt')
      expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:12345/')
      expect(url.searchParams.get('code_challenge_method')).toBe('S256')
      expect(url.searchParams.get('resource')).toBe('https://api.openai.com/v1')
      post.mockReturnValue(
        stubJsonResponse({
          access_token: 'access',
          refresh_token: 'refresh',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'chatgpt.tokens.use.direct',
          id_token: await token({ nonce: url.searchParams.get('nonce') }),
        }),
      )
      callback(`http://localhost:12345/?code=code&state=${url.searchParams.get('state')}&client_id=issued-client`)
    },
  })
  expect(credentials).toMatchObject({
    access_token: 'access',
    refresh_token: 'refresh',
    oauth: { clientId: 'issued-client', subject: 'account' },
  })
  const body = post.mock.calls[0]?.[1]?.body as URLSearchParams
  expect(body.get('client_id')).toBe('issued-client')
  expect(body.get('redirect_uri')).toBe('http://127.0.0.1:12345/')
  expect(body.get('code_verifier')).toBeTruthy()
  expect(get).toHaveBeenCalledTimes(2)
})

test('rejects discovery endpoints outside the issuer before opening a browser', async () => {
  spyOn(http, 'get').mockReturnValue(
    stubJsonResponse({
      issuer: 'https://auth.openai.com',
      authorization_endpoint: 'https://auth.openai.com/authorize',
      token_endpoint: 'https://attacker.example/token',
      jwks_uri: 'https://auth.openai.com/jwks',
      revocation_endpoint: 'https://auth.openai.com/revoke',
    }),
  )
  const openExternalUrl = mock(async () => {})
  await expect(connectChatGPT(getDb(), new AbortController().signal, { openExternalUrl })).rejects.toThrow('Unexpected')
  expect(openExternalUrl).not.toHaveBeenCalled()
})

test('revokes ChatGPT before disconnecting while retaining the issued client registration', async () => {
  spyOn(session, 'withProviderOAuthLock').mockImplementation(async (_id, work) => work())
  const metadata = {
    issuer: 'https://auth.openai.com',
    authorization_endpoint: 'https://auth.openai.com/authorize',
    token_endpoint: 'https://auth.openai.com/token',
    jwks_uri: 'https://auth.openai.com/jwks',
    revocation_endpoint: 'https://auth.openai.com/revoke',
  }
  spyOn(http, 'get').mockReturnValue(stubJsonResponse(metadata))
  const post = spyOn(http, 'post').mockReturnValue(stubJsonResponse({}))
  const id = await saveProviderConnection(getDb(), {
    provider: 'openai',
    name: 'ChatGPT',
    authMethod: 'oauth',
    credentials: {
      access_token: 'access',
      refresh_token: 'refresh',
      oauth: {
        clientId: 'issued-client',
        issuer: metadata.issuer,
        tokenEndpoint: metadata.token_endpoint,
        resource: 'https://api.openai.com/v1',
        subject: 'account',
        idToken: 'identity',
      },
    },
  })
  await disconnectProviderConnection(getDb(), id)
  expect(post.mock.calls[0]?.[0]).toBe(metadata.revocation_endpoint)
  expect((post.mock.calls[0]?.[1]?.body as URLSearchParams).get('token')).toBe('refresh')
  expect(await getProviderConnection(getDb(), id)).toMatchObject({ connected: false })
  expect(await readChatGPTRegistration(getDb())).toMatchObject({ clientId: 'issued-client', subject: 'account' })
  expect((await readChatGPTRegistration(getDb()))?.idToken).toBeUndefined()
})

test('uses the account catalog names and preserves ordering of visible ChatGPT models', async () => {
  const id = await saveProviderConnection(getDb(), {
    provider: 'openai',
    name: 'ChatGPT',
    authMethod: 'oauth',
    credentials: { access_token: 'plan-token' },
  })
  const get = spyOn(http, 'get').mockReturnValue(
    stubJsonResponse({
      models: [
        { slug: 'second', display_name: 'Second', visibility: 'list' },
        { slug: 'hidden', display_name: 'Hidden', visibility: 'hide' },
        { slug: 'first', display_name: 'First', visibility: 'list' },
      ],
    }),
  )
  expect(await fetchProviderModels(getDb(), id)).toEqual([
    { id: 'second', name: 'Second' },
    { id: 'first', name: 'First' },
  ])
  expect(get.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/models')
  expect(get.mock.calls[0]?.[1]?.headers).toEqual({ Authorization: 'Bearer plan-token' })
})

const metadata = {
  issuer: 'https://auth.openai.com',
  authorization_endpoint: 'https://auth.openai.com/authorize',
  token_endpoint: 'https://auth.openai.com/token',
  jwks_uri: 'https://auth.openai.com/jwks',
  revocation_endpoint: 'https://auth.openai.com/revoke',
}

/** Drive the real callback parser while replacing the native browser/listener boundary. */
const loopbackPlatform = (
  onAuthorize: (url: URL, callback: (url: string) => void) => Promise<void>,
): Partial<OpenRouterAuthDependencies> => {
  let callback = (_url: string) => {}
  return {
    isTauri: () => true,
    isMobile: () => false,
    startLoopback: async () => 12345,
    stopLoopback: async () => {},
    listenForLoopback: async (listener) => {
      callback = listener
      return () => {}
    },
    openExternalUrl: async (url) => onAuthorize(new URL(url), callback),
  }
}

/** Only token exchange varies across these recovery tests. */
const mockEndpoints = () => {
  spyOn(http, 'get').mockImplementation((url) => stubJsonResponse(String(url).endsWith('/jwks') ? jwks : metadata))
  return spyOn(http, 'post')
}

/** A valid state-bound callback; omission of client_id exercises returning sign-in. */
const callbackUrl = (url: URL, clientId?: string) =>
  `http://localhost:12345/?code=code&state=${url.searchParams.get('state')}${clientId ? `&client_id=${clientId}` : ''}`

/** Sign a fresh nonce-bound identity returned by the mocked issuer. */
const tokenResponse = async (url: URL, scope = 'openid chatgpt.tokens.use.direct', sub = 'account') => ({
  access_token: 'access',
  refresh_token: 'refresh',
  token_type: 'Bearer',
  expires_in: 3600,
  scope,
  id_token: await token({ nonce: url.searchParams.get('nonce'), sub }),
})

/** Persist an actual successful authorization, including a consent-pending identity. */
const saveChatGPT = async (credentials: Awaited<ReturnType<typeof connectChatGPT>>) =>
  saveProviderConnection(getDb(), { provider: 'openai', name: 'ChatGPT', authMethod: 'oauth', credentials })

test('retains a newly issued client after exchange failure and reuses it on retry', async () => {
  const post = mockEndpoints()
  post.mockImplementation(() => {
    throw new Error('exchange failed')
  })
  await expect(
    connectChatGPT(
      getDb(),
      new AbortController().signal,
      loopbackPlatform(async (url, callback) => {
        callback(callbackUrl(url, 'issued-client'))
      }),
    ),
  ).rejects.toThrow('exchange failed')
  expect(await readChatGPTRegistration(getDb())).toEqual({ clientId: 'issued-client' })
  expect(await getProviderConnection(getDb(), 'oauth:openai')).toBeNull()
  expect(await getProviderCredentials(getDb(), 'oauth:openai')).toBeNull()

  const credentials = await connectChatGPT(
    getDb(),
    new AbortController().signal,
    loopbackPlatform(async (url, callback) => {
      expect(url.searchParams.get('client_id')).toBe('issued-client')
      expect(url.searchParams.has('agent_name_hint')).toBe(false)
      post.mockReturnValue(stubJsonResponse(await tokenResponse(url)))
      callback(callbackUrl(url))
    }),
  )
  await saveChatGPT(credentials)
  expect(await getProviderConnection(getDb(), 'oauth:openai')).toMatchObject({ connected: true, needsConsent: false })
})

test('retains declined plan consent as a signed-in identity, then enables access after explicit consent', async () => {
  const post = mockEndpoints()
  const consentPending = await connectChatGPT(
    getDb(),
    new AbortController().signal,
    loopbackPlatform(async (url, callback) => {
      post.mockReturnValue(stubJsonResponse(await tokenResponse(url, 'openid profile')))
      callback(callbackUrl(url, 'issued-client'))
    }),
  )
  expect(consentPending.reauth_required).toBe(true)
  await saveChatGPT(consentPending)
  expect(await getProviderConnection(getDb(), 'oauth:openai')).toMatchObject({ connected: false, needsConsent: true })
  expect(await getProviderCredentials(getDb(), 'oauth:openai')).toBeNull()
  const connected = await connectChatGPT(
    getDb(),
    new AbortController().signal,
    loopbackPlatform(async (url, callback) => {
      expect(url.searchParams.get('client_id')).toBe('issued-client')
      expect(url.searchParams.get('id_token_hint')).toBe(consentPending.oauth?.idToken ?? null)
      expect(url.searchParams.get('prompt')).toBe('consent')
      post.mockReturnValue(stubJsonResponse(await tokenResponse(url)))
      callback(callbackUrl(url))
    }),
  )
  await saveChatGPT(connected)
  expect(await getProviderConnection(getDb(), 'oauth:openai')).toMatchObject({ connected: true, needsConsent: false })
})

test.each(['exchange failure', 'changed client', 'changed account'] as const)(
  'preserves the current account and credential revision after %s',
  async (failure) => {
    const post = mockEndpoints()
    const current = await connectChatGPT(
      getDb(),
      new AbortController().signal,
      loopbackPlatform(async (url, callback) => {
        post.mockReturnValue(stubJsonResponse(await tokenResponse(url)))
        callback(callbackUrl(url, 'issued-client'))
      }),
    )
    await saveChatGPT(current)
    const revision = await getProviderConnectionRevision(getDb(), 'oauth:openai')
    const stored = await getProviderCredentials(getDb(), 'oauth:openai')
    await expect(
      connectChatGPT(
        getDb(),
        new AbortController().signal,
        loopbackPlatform(async (url, callback) => {
          expect(url.searchParams.has('prompt')).toBe(false)
          if (failure === 'exchange failure') {
            post.mockImplementation(() => {
              throw new Error('exchange failed')
            })
          } else {
            post.mockReturnValue(
              stubJsonResponse(
                await tokenResponse(
                  url,
                  'chatgpt.tokens.use.direct',
                  failure === 'changed account' ? 'other' : 'account',
                ),
              ),
            )
          }
          callback(callbackUrl(url, failure === 'changed client' ? 'other-client' : undefined))
        }),
      ),
    ).rejects.toThrow()
    expect(await getProviderCredentials(getDb(), 'oauth:openai')).toEqual(stored)
    expect(await getProviderConnectionRevision(getDb(), 'oauth:openai')).toBe(revision)
  },
)

test('retains another window’s registration independently of this pending exchange', async () => {
  const post = mockEndpoints()
  post.mockImplementation(() => {
    throw new Error('exchange failed')
  })
  await expect(
    connectChatGPT(
      getDb(),
      new AbortController().signal,
      loopbackPlatform(async (url, callback) => {
        await writeChatGPTRegistration(getDb(), { clientId: 'other-client' })
        callback(callbackUrl(url, 'issued-client'))
      }),
    ),
  ).rejects.toThrow('exchange failed')
  expect((await listChatGPTAccounts(getDb())).map((entry) => entry.clientId)).toEqual(['issued-client', 'other-client'])
})

test('cancellation before callback cannot persist a registration', async () => {
  mockEndpoints()
  const controller = new AbortController()
  await expect(
    connectChatGPT(
      getDb(),
      controller.signal,
      loopbackPlatform(async (url, callback) => {
        controller.abort()
        callback(callbackUrl(url, 'issued-client'))
      }),
    ),
  ).rejects.toThrow()
  expect(await readChatGPTRegistration(getDb())).toBeUndefined()
})

test('disconnecting and removing a consent-pending connection clears tokens but retains its account registration', async () => {
  spyOn(session, 'withProviderOAuthLock').mockImplementation(async (_id, work) => work())
  const post = mockEndpoints()
  const credentials = await connectChatGPT(
    getDb(),
    new AbortController().signal,
    loopbackPlatform(async (url, callback) => {
      post.mockReturnValue(stubJsonResponse(await tokenResponse(url, 'openid')))
      callback(callbackUrl(url, 'issued-client'))
    }),
  )
  await saveChatGPT(credentials)
  post.mockReturnValue(stubJsonResponse({}))
  await deleteProviderConnection(getDb(), 'oauth:openai')
  expect(await getProviderConnection(getDb(), 'oauth:openai')).toBeNull()
  const registration = await readChatGPTRegistration(getDb())
  expect(registration).toMatchObject({ clientId: 'issued-client', subject: 'account' })
  expect(registration?.idToken).toBeUndefined()
  const row = await getDb().select().from(secrets).where(eq(secrets.id, 'oauth:openai')).get()
  const stored = JSON.parse(row!.credentials!)
  expect(stored.access_token).toBeUndefined()
  expect(stored.refresh_token).toBeUndefined()
})

test.each([{ azp: 'another-client' }, { aud: ['issued-client', 'another-client'] }])(
  'rejects a signed identity for another authorized party: %j',
  async (claims) => {
    await expect(validateChatGPTIdentity(await token(claims), jwks, 'issued-client', 'nonce')).rejects.toThrow(
      'authorized party',
    )
  },
)

test('accepts a multi-audience identity only for the issued authorized party', async () => {
  expect(
    await validateChatGPTIdentity(
      await token({ aud: ['issued-client', 'another'], azp: 'issued-client' }),
      jwks,
      'issued-client',
      'nonce',
    ),
  ).toMatchObject({ subject: 'account' })
})

test('registers another account separately and retries a chosen saved registration', async () => {
  const post = mockEndpoints()
  const active = await connectChatGPT(
    getDb(),
    new AbortController().signal,
    loopbackPlatform(async (url, callback) => {
      post.mockReturnValue(stubJsonResponse(await tokenResponse(url)))
      callback(callbackUrl(url, 'issued-client'))
    }),
  )
  await saveChatGPT(active)
  const before = await getProviderCredentials(getDb(), 'oauth:openai')
  const other = await connectChatGPT(
    getDb(),
    new AbortController().signal,
    loopbackPlatform(async (url, callback) => {
      expect(url.searchParams.get('client_id')).toBe('dynamic_agent_client')
      expect(url.searchParams.has('id_token_hint')).toBe(false)
      post.mockReturnValue(
        stubJsonResponse({
          access_token: 'other-access',
          refresh_token: 'other-refresh',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'openid chatgpt.tokens.use.direct',
          id_token: await token({
            aud: 'second-client',
            sub: 'second-account',
            email: 'account@example.test',
            name: 'Other account',
            nonce: url.searchParams.get('nonce'),
          }),
        }),
      )
      callback(callbackUrl(url, 'second-client'))
    }),
    null,
  )
  expect(other.oauth).toMatchObject({ clientId: 'second-client', subject: 'second-account' })
  // Only the guarded connection save may replace the active session; registration never does.
  expect(await getProviderCredentials(getDb(), 'oauth:openai')).toEqual(before)
  expect(await listChatGPTAccounts(getDb())).toEqual([
    { clientId: 'issued-client', label: expect.stringContaining('issued-client'), active: true },
    { clientId: 'second-client', label: 'Other account · second-client', active: false },
  ])
  const rows = await getDb().select().from(secrets)
  for (const row of rows.filter((row) => row.id !== 'oauth:openai')) {
    const stored = JSON.parse(row.credentials!)
    expect(stored.access_token).toBeUndefined()
    expect(stored.refresh_token).toBeUndefined()
    expect(stored.chatGPTRegistration.idToken).toBeUndefined()
  }
  await expect(
    connectChatGPT(
      getDb(),
      new AbortController().signal,
      loopbackPlatform(async (url, callback) => {
        expect(url.searchParams.get('client_id')).toBe('second-client')
        expect(url.searchParams.has('id_token_hint')).toBe(false)
        post.mockImplementation(() => {
          throw new Error('retry exchange failed')
        })
        callback(callbackUrl(url))
      }),
      'second-client',
    ),
  ).rejects.toThrow('retry exchange failed')
  expect(await getProviderCredentials(getDb(), 'oauth:openai')).toEqual(before)
})

test('rejects an unknown selected account without opening a browser', async () => {
  mockEndpoints()
  const open = mock(async () => {})
  await expect(
    connectChatGPT(getDb(), new AbortController().signal, loopbackPlatform(open), 'missing-client'),
  ).rejects.toThrow('not found')
  expect(open).not.toHaveBeenCalled()
})

test('finishes a started token response on cancellation and revokes the unused grant', async () => {
  const post = mockEndpoints()
  const controller = new AbortController()
  await expect(
    connectChatGPT(
      getDb(),
      controller.signal,
      loopbackPlatform(async (url, callback) => {
        const tokens = await tokenResponse(url)
        post.mockImplementation((endpoint, options) => {
          if (endpoint !== metadata.token_endpoint) {
            return stubJsonResponse({})
          }
          const response = stubJsonResponse(tokens)
          response.json = async <T>() => {
            controller.abort()
            expect(options?.signal?.aborted).toBe(false)
            return tokens as T
          }
          return response
        })
        callback(callbackUrl(url, 'issued-client'))
      }),
    ),
  ).rejects.toHaveProperty('name', 'AbortError')
  expect(post.mock.calls.map(([url]) => url)).toEqual([metadata.token_endpoint, metadata.revocation_endpoint])
  expect((post.mock.calls[1]?.[1]?.body as URLSearchParams).get('token')).toBe('refresh')
  expect(await getProviderCredentials(getDb(), 'oauth:openai')).toBeNull()
})

test('revokes a newly issued grant when cancellation prevents validating its identity', async () => {
  const post = mockEndpoints()
  const controller = new AbortController()
  const get = spyOn(http, 'get').mockImplementation((url) => {
    if (String(url).endsWith('/jwks')) {
      controller.abort()
      return stubJsonResponse(jwks)
    }
    return stubJsonResponse(metadata)
  })
  await expect(
    connectChatGPT(
      getDb(),
      controller.signal,
      loopbackPlatform(async (url, callback) => {
        post.mockReturnValue(stubJsonResponse(await tokenResponse(url)))
        callback(callbackUrl(url, 'issued-client'))
      }),
    ),
  ).rejects.toThrow()
  expect(get).toHaveBeenCalled()
  expect(post.mock.calls.map(([url]) => url)).toEqual([metadata.token_endpoint, metadata.revocation_endpoint])
  expect((post.mock.calls[1]?.[1]?.body as URLSearchParams).get('token')).toBe('refresh')
  expect(await getProviderCredentials(getDb(), 'oauth:openai')).toBeNull()
  expect(await readChatGPTRegistration(getDb())).toMatchObject({ clientId: 'issued-client' })
})

test.each(['refresh matches', 'rotated after save'] as const)(
  'does not revoke an installed grant after a later UI failure: %s',
  async (scenario) => {
    const post = mockEndpoints()
    const credentials = {
      access_token: 'access',
      refresh_token: 'issued-refresh',
      oauth: {
        clientId: 'issued-client',
        issuer: metadata.issuer,
        tokenEndpoint: metadata.token_endpoint,
        resource: 'https://api.openai.com/v1',
        idToken: 'nonce-bound-identity',
      },
    }
    await saveChatGPT({
      ...credentials,
      refresh_token: scenario === 'refresh matches' ? credentials.refresh_token : 'rotated-refresh',
    })
    await discardChatGPTAuthorization(getDb(), credentials)
    expect(post).not.toHaveBeenCalled()
  },
)

test('reports when an unused renewable session could not be revoked', async () => {
  const post = mockEndpoints()
  post.mockImplementation(() => {
    throw new Error('network unavailable')
  })
  await expect(
    discardChatGPTAuthorization(getDb(), {
      refresh_token: 'unused',
      oauth: {
        clientId: 'issued-client',
        issuer: metadata.issuer,
        tokenEndpoint: metadata.token_endpoint,
        resource: 'https://api.openai.com/v1',
      },
    }),
  ).rejects.toBeInstanceOf(ChatGPTCleanupError)
})
