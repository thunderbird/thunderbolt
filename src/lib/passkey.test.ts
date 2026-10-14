/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, mock } from 'bun:test'
import { bufferToBase64URLString, WebAuthnError } from '@simplewebauthn/browser'
import { useConfigStore } from '@/api/config-store'
import type { AuthClient } from '@/contexts'

// Mock the browser ceremony primitives so tests never touch a real authenticator.
const prfBytes = new Uint8Array(32).fill(5)
const startRegistration = mock(async () => ({
  id: 'cred-reg',
  clientExtensionResults: { credProps: { rk: true }, prf: { enabled: true, results: { first: prfBytes.buffer } } },
}))
const startAuthentication = mock(async () => ({ id: 'cred-auth', clientExtensionResults: {} }))

mock.module('@simplewebauthn/browser', () => ({
  startRegistration,
  startAuthentication,
  bufferToBase64URLString,
  WebAuthnError,
}))

const {
  registerPasskey,
  signInWithPasskey,
  listPasskeys,
  isPasskeyCancellation,
  isSessionNotFresh,
  getPasskeyPrfOutput,
} = await import('./passkey')

type FetchCall = { path: string; options: { method: string; body?: unknown; credentials?: string } }

type FetchResult = { data?: unknown; error?: unknown }

/** Minimal AuthClient stand-in: records $fetch calls and returns queued results. */
const makeAuthClient = (results: FetchResult[], session: FetchResult = { data: { user: { id: 'user-1' } } }) => {
  const calls: FetchCall[] = []
  let i = 0
  return {
    calls,
    $fetch: mock(async (path: string, options: { method: string; body?: unknown }) => {
      calls.push({ path, options })
      return results[i++] ?? { data: null, error: null }
    }),
    getSession: mock(async () => session),
    $store: { atoms: { session: { get: () => ({ isPending: true }), set: mock(() => {}) } } },
  } as unknown as AuthClient & { calls: FetchCall[] }
}

afterEach(() => {
  startRegistration.mockClear()
  startAuthentication.mockClear()
})

describe('isPasskeyCancellation', () => {
  it('is true for a NotAllowedError WebAuthnError (user dismissed the prompt)', () => {
    const err = new WebAuthnError({
      message: 'cancelled',
      code: 'ERROR_CEREMONY_ABORTED',
      cause: new Error('abort'),
      name: 'NotAllowedError',
    })
    expect(isPasskeyCancellation(err)).toBe(true)
  })

  it('is false for a generic error', () => {
    expect(isPasskeyCancellation(new Error('network down'))).toBe(false)
    expect(isPasskeyCancellation(null)).toBe(false)
  })
})

describe('isSessionNotFresh', () => {
  it('recognizes the server refusing an old session, before any passkey prompt', async () => {
    startRegistration.mockClear()
    const authClient = makeAuthClient([
      { data: null, error: { status: 403, code: 'SESSION_NOT_FRESH', message: 'Session is not fresh' } },
    ])
    const error = await registerPasskey(authClient).catch((err: unknown) => err)
    expect(isSessionNotFresh(error)).toBe(true)
    expect(startRegistration).not.toHaveBeenCalled()
  })

  it('ignores other failures', () => {
    expect(isSessionNotFresh({ status: 409, code: 'CONFLICT' })).toBe(false)
    expect(isSessionNotFresh(new Error('network down'))).toBe(false)
    expect(isSessionNotFresh(null)).toBe(false)
  })
})

describe('registerPasskey', () => {
  it('fetches options, runs the ceremony, and posts the response for verification', async () => {
    const authClient = makeAuthClient([
      { data: { challenge: 'abc' } }, // generate-register-options
      { data: { id: 'pk-1', credentialID: 'cred-reg' } }, // verify-registration
    ])

    const result = await registerPasskey(authClient, 'My laptop')

    expect(startRegistration).toHaveBeenCalledTimes(1)
    expect(authClient.calls[0]?.path).toBe('/passkey/generate-register-options')
    expect(authClient.calls[1]?.path).toBe('/passkey/verify-registration')
    expect(result.passkey.id).toBe('pk-1')
    expect(result.passkey.credentialID).toBe('cred-reg')
    expect(result.prfOutput).toEqual(prfBytes)
  })

  it('never sends the PRF output to the server', async () => {
    const authClient = makeAuthClient([
      { data: { challenge: 'abc' } },
      { data: { id: 'pk-1', credentialID: 'cred-reg' } },
    ])

    await registerPasskey(authClient, 'My laptop')

    expect(authClient.calls[1]?.options.body).toEqual({
      response: { id: 'cred-reg', clientExtensionResults: { credProps: { rk: true } } },
      name: 'My laptop',
    })
  })

  it('throws when the server returns an error', async () => {
    const authClient = makeAuthClient([{ error: { message: 'nope' } }])
    await expect(registerPasskey(authClient)).rejects.toEqual({ message: 'nope' })
  })
})

describe('signInWithPasskey', () => {
  it('verifies the assertion and refreshes the session, returning the user id', async () => {
    const authClient = makeAuthClient([
      { data: { challenge: 'xyz' } }, // generate-authenticate-options
      { data: { token: 't' } }, // verify-authentication
    ])

    const result = await signInWithPasskey(authClient)

    expect(startAuthentication).toHaveBeenCalledTimes(1)
    expect(authClient.calls[0]?.path).toBe('/passkey/generate-authenticate-options')
    expect(authClient.calls[1]?.path).toBe('/passkey/verify-authentication')
    expect(authClient.getSession).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ userId: 'user-1' })
  })
})

describe('listPasskeys', () => {
  it('returns the credential list from the server', async () => {
    const authClient = makeAuthClient([{ data: [{ id: 'pk-1' }] }])
    const result = await listPasskeys(authClient)
    expect(authClient.calls[0]?.path).toBe('/passkey/list-user-passkeys')
    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe('pk-1')
  })

  it('does NOT send cookies — bearer-only, so a stale session cookie cannot 401 it', async () => {
    const authClient = makeAuthClient([{ data: [] }])
    await listPasskeys(authClient)
    expect(authClient.calls[0]?.options.credentials).toBeUndefined()
  })
})

describe('challenge cookie scoping', () => {
  it('ceremony calls opt into cookies; management calls do not', async () => {
    const registerClient = makeAuthClient([{ data: { challenge: 'a' } }, { data: { id: 'pk' } }])
    await registerPasskey(registerClient)
    expect(registerClient.calls[0]?.options.credentials).toBe('include')
    expect(registerClient.calls[1]?.options.credentials).toBe('include')
  })
})

describe('signInWithPasskey — session refresh', () => {
  it('fails when the session comes back empty', async () => {
    const authClient = makeAuthClient([{ data: { challenge: 'abc' } }, { data: { verified: true } }], {
      data: null,
      error: null,
    })

    await expect(signInWithPasskey(authClient)).rejects.toThrow('no session was returned')
  })

  it('never lets a server-chosen PRF request reach the authenticator or a PRF output reach the server', async () => {
    startAuthentication.mockImplementationOnce(async () => ({
      id: 'cred-auth',
      clientExtensionResults: { prf: { results: { first: prfBytes.buffer } } },
    }))
    const authClient = makeAuthClient([
      { data: { challenge: 'abc', extensions: { prf: { eval: { first: 'server-salt' } } } } },
      { data: { verified: true } },
    ])

    await signInWithPasskey(authClient)

    const [{ optionsJSON }] = startAuthentication.mock.calls.at(-1) as unknown as [
      { optionsJSON: Record<string, unknown> },
    ]
    expect(optionsJSON.extensions).toBeUndefined()
    expect(authClient.calls[1]?.options.body).toEqual({ response: { id: 'cred-auth', clientExtensionResults: {} } })
  })

  it('fails instead of reporting success when the session cannot be loaded', async () => {
    const authClient = makeAuthClient([{ data: { challenge: 'abc' } }, { data: { verified: true } }], {
      data: null,
      error: { message: 'network' },
    })

    await expect(signInWithPasskey(authClient)).rejects.toEqual({ message: 'network' })
  })
})

describe('getPasskeyPrfOutput', () => {
  it('asks only the given passkey for its PRF output, with no server round trip', async () => {
    startAuthentication.mockImplementationOnce(async () => ({
      id: 'cred-auth',
      clientExtensionResults: { prf: { results: { first: prfBytes.buffer } } },
    }))

    const output = await getPasskeyPrfOutput('cred-1')

    expect(output).toEqual(prfBytes)
    const [{ optionsJSON }] = startAuthentication.mock.calls[0] as unknown as [
      { optionsJSON: { allowCredentials: Array<{ id: string; type: string }>; extensions: { prf: unknown } } },
    ]
    expect(optionsJSON.allowCredentials).toEqual([{ id: 'cred-1', type: 'public-key' }])
    expect(optionsJSON.extensions.prf).toBeDefined()
  })

  it('returns null when the provider has no PRF support', async () => {
    expect(await getPasskeyPrfOutput('cred-1')).toBeNull()
  })

  it('asserts under the configured RP ID, so an apex RP ID works from a subdomain', async () => {
    const { config } = useConfigStore.getState()
    useConfigStore.getState().updateConfig({ ...config, passkeyRpId: 'example.com' })
    try {
      await getPasskeyPrfOutput('cred-1')
      const [{ optionsJSON }] = startAuthentication.mock.calls[0] as unknown as [{ optionsJSON: { rpId?: string } }]
      expect(optionsJSON.rpId).toBe('example.com')
    } finally {
      useConfigStore.getState().updateConfig(config)
    }
  })
})
