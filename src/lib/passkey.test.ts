/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, mock } from 'bun:test'
import { WebAuthnError } from '@simplewebauthn/browser'

// Mock the browser ceremony primitives so tests never touch a real authenticator.
const startRegistration = mock(async () => ({ id: 'cred-reg' }))
const startAuthentication = mock(async () => ({ id: 'cred-auth' }))

mock.module('@simplewebauthn/browser', () => ({
  startRegistration,
  startAuthentication,
  WebAuthnError,
}))

const { registerPasskey, signInWithPasskey, listPasskeys, isPasskeyCancellation } = await import('./passkey')

type FetchCall = { path: string; options: { method: string; body?: unknown; credentials?: string } }

/** Minimal AuthClient stand-in: records $fetch calls and returns queued results. */
const makeAuthClient = (results: Array<{ data?: unknown; error?: unknown }>) => {
  const calls: FetchCall[] = []
  let i = 0
  return {
    calls,
    $fetch: mock(async (path: string, options: { method: string; body?: unknown }) => {
      calls.push({ path, options })
      return results[i++] ?? { data: null, error: null }
    }),
    getSession: mock(async () => ({ data: { user: { id: 'user-1' } } })),
    $store: { atoms: { session: { get: () => ({ isPending: true }), set: mock(() => {}) } } },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
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
    expect(authClient.calls[1]?.options.body).toEqual({ response: { id: 'cred-reg' }, name: 'My laptop' })
    expect(result.id).toBe('pk-1')
    expect(result.credentialID).toBe('cred-reg')
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
    // both generate + verify carry the challenge cookie
    expect(registerClient.calls[0]?.options.credentials).toBe('include')
    expect(registerClient.calls[1]?.options.credentials).toBe('include')
  })
})
