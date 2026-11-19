/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { bufferToBase64URLString, WebAuthnError } from '@simplewebauthn/browser'
import * as tauriCore from '@tauri-apps/api/core'
import * as os from '@tauri-apps/plugin-os'
import { useConfigStore } from '@/api/config-store'
import type { AuthClient } from '@/contexts'
import * as platformModule from '@/lib/platform'
import { createAuthClient } from 'better-auth/react'
import { anonymousClient, emailOTPClient } from 'better-auth/client/plugins'
import { buildFetchOptions } from '@/contexts/auth-context'
import { clearAuthToken, getAuthToken, setAuthToken } from '@/lib/auth-token'
import * as onboarding from '@/lib/returning-user-onboarding'
import {
  bindLocalData,
  getLocalDataStatus,
  isLocalDataOwnedBy,
  openLocalData,
  resetLocalDataOwnerForTests,
} from '@/lib/local-data-owner'
import { getClock } from '@/testing-library'

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
  isPasskeyCapable,
  isSessionNotFresh,
  getPasskeyPrfOutput,
} = await import('./passkey')

type FetchCall = {
  path: string
  options: {
    method: string
    body?: unknown
    credentials?: string
    headers?: Record<string, string>
    onResponse?: (context: { response: Response }) => void
  }
}

const acceptedSession = { user: { id: 'user-1', isNew: false }, session: { id: 'session-1', token: 'accepted' } }

type FetchResult = { data?: unknown; error?: unknown; headers?: Record<string, string> }

/** Minimal AuthClient stand-in: records $fetch calls and returns queued results. */
const makeAuthClient = (
  results: Array<FetchResult | Promise<FetchResult>>,
  session: FetchResult = { data: { user: { id: 'user-1' } } },
) => {
  const calls: FetchCall[] = []
  let i = 0
  return {
    calls,
    $fetch: mock(async (path: string, options: FetchCall['options']) => {
      calls.push({ path, options })
      const { headers, ...result } = await (results[i++] ?? { data: null, error: null })
      options.onResponse?.({ response: new Response(null, { headers }) })
      return result
    }),
    getSession: mock(async () => session),
    $store: { atoms: { session: { get: () => ({ isPending: true }), set: mock(() => {}) } } },
  } as unknown as AuthClient & { calls: FetchCall[] }
}

afterEach(() => {
  startRegistration.mockClear()
  startAuthentication.mockClear()
  mock.restore()
})

/** Run `fn` with the config's passkey RP ID set to `rpId`, restoring it afterwards. */
const withPasskeyRpId = async (rpId: string | undefined, fn: () => unknown) => {
  const { config } = useConfigStore.getState()
  useConfigStore.getState().updateConfig({ ...config, passkeyRpId: rpId })
  try {
    await fn()
  } finally {
    useConfigStore.getState().updateConfig(config)
  }
}

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
  it('publishes the verified session without another network request, returning the user id', async () => {
    const authClient = makeAuthClient([
      { data: { challenge: 'xyz' } }, // generate-authenticate-options
      { data: acceptedSession }, // verify-authentication
    ])

    const result = await signInWithPasskey(authClient)

    expect(startAuthentication).toHaveBeenCalledTimes(1)
    expect(authClient.calls[0]?.path).toBe('/passkey/generate-authenticate-options')
    expect(authClient.calls[1]?.path).toBe('/passkey/verify-authentication')
    expect(authClient.getSession).not.toHaveBeenCalled()
    expect(authClient.$store.atoms.session.set).toHaveBeenCalledWith(
      expect.objectContaining({ data: acceptedSession, isPending: false }),
    )
    expect(result).toEqual({ userId: 'user-1' })
  })
})

describe('signInWithPasskey — anonymous promotion (THU-963)', () => {
  /** `previous` owns the open slot and holds the session when the passkey signs in user-1. */
  const signInAfter = async (previous: { id: string; isAnonymous: boolean }) => {
    localStorage.clear()
    spyOn(platformModule, 'isOpfsAvailable').mockResolvedValue(false)
    spyOn(platformModule, 'hasIndexedDbDatabase').mockResolvedValue(false)
    spyOn(onboarding, 'markOnboardedForReturningUser').mockResolvedValue()
    await openLocalData()
    // Boot takes the lock too; only a later account switch should wait here.
    spyOn(navigator.locks, 'request').mockReturnValue(new Promise(() => {}))
    bindLocalData(previous.id)
    const authClient = makeAuthClient([{ data: { challenge: 'xyz' } }, { data: acceptedSession }])
    const atom = authClient.$store.atoms.session
    spyOn(atom, 'get').mockReturnValue({ ...atom.get(), data: { user: previous } })
    await signInWithPasskey(authClient)
  }

  afterEach(() => {
    resetLocalDataOwnerForTests()
    localStorage.clear()
  })

  it('hands the anonymous account’s local data to the account it became', async () => {
    await signInAfter({ id: 'anon-1', isAnonymous: true })
    expect(isLocalDataOwnedBy('user-1')).toBe(true)
  })

  it('never hands a named account’s local data to the next sign-in, and switches instead', async () => {
    await signInAfter({ id: 'user-a', isAnonymous: false })
    expect(isLocalDataOwnedBy('user-1')).toBe(false)
    expect(getLocalDataStatus()).toBe('switching')
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

describe('challenge relay', () => {
  const challenge = { 'X-Passkey-Challenge': 'better-auth.better-auth-passkey=token.sig' }

  it('sends the options call challenge back with verify-registration, without cookies', async () => {
    const authClient = makeAuthClient([{ data: { challenge: 'a' }, headers: challenge }, { data: { id: 'pk' } }])
    await registerPasskey(authClient)
    expect(authClient.calls[1]?.options.headers).toMatchObject(challenge)
    expect(authClient.calls.map((call) => call.options.credentials)).toEqual([undefined, undefined])
  })

  it('sends the options call challenge back with verify-authentication, without cookies', async () => {
    const authClient = makeAuthClient([{ data: { challenge: 'a' }, headers: challenge }, { data: acceptedSession }])
    await signInWithPasskey(authClient)
    expect(authClient.calls[1]?.options.headers).toMatchObject(challenge)
    expect(authClient.calls.map((call) => call.options.credentials)).toEqual([undefined, undefined])
  })

  it('sends no challenge header when the options call relayed none', async () => {
    const authClient = makeAuthClient([{ data: { challenge: 'a' } }, { data: { id: 'pk' } }])
    await registerPasskey(authClient)
    expect(authClient.calls[1]?.options.headers).not.toHaveProperty('X-Passkey-Challenge')
  })
})

describe('signInWithPasskey — accepted session', () => {
  it('stops before the authenticator when cancelled while loading ceremony options', async () => {
    const options = Promise.withResolvers<FetchResult>()
    const controller = new AbortController()
    const authClient = makeAuthClient([options.promise])
    const result = signInWithPasskey(authClient, { signal: controller.signal }).catch((error: unknown) => error)
    controller.abort()
    options.resolve({ data: { challenge: 'abc' } })
    expect(await result).toMatchObject({ name: 'AbortError' })
    expect(startAuthentication).not.toHaveBeenCalled()
    expect(authClient.$store.atoms.session.set).not.toHaveBeenCalled()
  })

  it('does not verify an assertion returned after its flow was cancelled', async () => {
    const assertion = Promise.withResolvers<{ id: string; clientExtensionResults: Record<string, never> }>()
    startAuthentication.mockReturnValueOnce(assertion.promise)
    const controller = new AbortController()
    const onAuthenticated = mock(() => {})
    const authClient = makeAuthClient([{ data: { challenge: 'abc' } }, { data: acceptedSession }])
    const result = signInWithPasskey(authClient, { signal: controller.signal, onAuthenticated }).catch(
      (error: unknown) => error,
    )
    await getClock().tickAsync(0)
    expect(startAuthentication).toHaveBeenCalledTimes(1)
    controller.abort()
    assertion.resolve({ id: 'late', clientExtensionResults: {} })
    expect(await result).toMatchObject({ name: 'AbortError' })
    expect(authClient.calls.map(({ path }) => path)).toEqual(['/passkey/generate-authenticate-options'])
    expect(onAuthenticated).not.toHaveBeenCalled()
    expect(authClient.$store.atoms.session.set).not.toHaveBeenCalled()
  })

  it.each(['cancel-before-commit', 'close-after-commit', 'logout-after-commit'] as const)(
    'owns real token and session publication: %s',
    async (action) => {
      const controller = new AbortController()
      const verification = Promise.withResolvers<Response>()
      const housekeeping = Promise.withResolvers<void>()
      const markOnboarded = spyOn(onboarding, 'markOnboardedForReturningUser').mockReturnValue(housekeeping.promise)
      const onAuthenticated = mock(() => {
        expect(getAuthToken()).toBe('accepted.signature')
        controller.abort()
      })
      setAuthToken('previous.signature')
      const paths: string[] = []
      const client = createAuthClient({
        baseURL: 'https://auth.test',
        plugins: [emailOTPClient(), anonymousClient()],
        fetchOptions: {
          ...buildFetchOptions('web'),
          customFetchImpl: Object.assign(
            async (input: RequestInfo | URL, init?: RequestInit) => {
              const path = new URL(String(input)).pathname
              if (path.endsWith('/get-session')) {
                return Response.json(null)
              }
              paths.push(path)
              expect(init?.signal).toBe(controller.signal)
              return path.endsWith('/generate-authenticate-options')
                ? Response.json({ challenge: 'abc' })
                : verification.promise
            },
            { preconnect: () => {} },
          ),
        },
      })
      const sessionBefore = client.$store.atoms.session.get().data
      const result = signInWithPasskey(client, { signal: controller.signal, onAuthenticated }).catch(
        (error: unknown) => error,
      )
      await getClock().tickAsync(0)
      expect(paths).toHaveLength(2)
      if (action === 'cancel-before-commit') {
        controller.abort()
      }
      verification.resolve(Response.json(acceptedSession, { headers: { 'set-auth-token': 'accepted.signature' } }))
      await getClock().tickAsync(0)
      if (action === 'logout-after-commit') {
        clearAuthToken()
      }
      housekeeping.resolve()
      if (action === 'close-after-commit') {
        expect(await result).toEqual({ userId: 'user-1' })
        expect(getAuthToken()).toBe('accepted.signature')
        expect(client.$store.atoms.session.get().data).toEqual(acceptedSession)
      } else {
        expect(await result).toMatchObject({ name: 'AbortError' })
        expect(getAuthToken()).toBe(action === 'cancel-before-commit' ? 'previous.signature' : null)
        expect(client.$store.atoms.session.get().data).toBe(sessionBefore)
      }
      expect(onAuthenticated).toHaveBeenCalledTimes(action === 'cancel-before-commit' ? 0 : 1)
      expect(markOnboarded).toHaveBeenCalledTimes(action === 'cancel-before-commit' ? 0 : 1)
      expect(paths).toHaveLength(2)
    },
  )

  it('does not need a second session response after verification succeeds', async () => {
    const authClient = makeAuthClient([{ data: { challenge: 'abc' } }, { data: acceptedSession }], {
      data: null,
      error: { message: 'offline' },
    })
    await expect(signInWithPasskey(authClient)).resolves.toEqual({ userId: 'user-1' })
    expect(authClient.getSession).not.toHaveBeenCalled()
  })

  it('never lets a server-chosen PRF request reach the authenticator or a PRF output reach the server', async () => {
    startAuthentication.mockImplementationOnce(async () => ({
      id: 'cred-auth',
      clientExtensionResults: { prf: { results: { first: prfBytes.buffer } } },
    }))
    const authClient = makeAuthClient([
      { data: { challenge: 'abc', extensions: { prf: { eval: { first: 'server-salt' } } } } },
      { data: acceptedSession },
    ])

    await signInWithPasskey(authClient)

    const [{ optionsJSON }] = startAuthentication.mock.calls.at(-1) as unknown as [
      { optionsJSON: Record<string, unknown> },
    ]
    expect(optionsJSON.extensions).toBeUndefined()
    expect(authClient.calls[1]?.options.body).toEqual({ response: { id: 'cred-auth', clientExtensionResults: {} } })
  })

  it('does not publish a session or commit when verification is rejected', async () => {
    const authClient = makeAuthClient([{ data: { challenge: 'abc' } }, { error: { message: 'invalid assertion' } }])
    const onAuthenticated = mock(() => {})
    await expect(signInWithPasskey(authClient, { onAuthenticated })).rejects.toEqual({ message: 'invalid assertion' })
    expect(onAuthenticated).not.toHaveBeenCalled()
    expect(authClient.$store.atoms.session.set).not.toHaveBeenCalled()
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
    await withPasskeyRpId('example.com', async () => {
      await getPasskeyPrfOutput('cred-1')
      const [{ optionsJSON }] = startAuthentication.mock.calls[0] as unknown as [{ optionsJSON: { rpId?: string } }]
      expect(optionsJSON.rpId).toBe('example.com')
    })
  })
})

describe('isPasskeyCapable', () => {
  it('is true in a browser with WebAuthn', () => {
    const original = window.PublicKeyCredential
    window.PublicKeyCredential = class {} as unknown as typeof PublicKeyCredential
    try {
      expect(isPasskeyCapable()).toBe(true)
    } finally {
      window.PublicKeyCredential = original
    }
  })

  it('is true on the Apple apps only for the RP ID their entitlements name', async () => {
    spyOn(platformModule, 'getPlatform').mockReturnValue('ios')
    spyOn(os, 'version').mockReturnValue('18.2')
    await withPasskeyRpId('app.thunderbolt.io', () => expect(isPasskeyCapable()).toBe(true))
    await withPasskeyRpId('passkeys.example.com', () => expect(isPasskeyCapable()).toBe(false))
  })

  it('is false on iOS 15, which has no platform passkeys', async () => {
    spyOn(platformModule, 'getPlatform').mockReturnValue('ios')
    spyOn(os, 'version').mockReturnValue('15.8')
    await withPasskeyRpId('app.thunderbolt.io', () => expect(isPasskeyCapable()).toBe(false))
  })

  it('needs macOS 13 for platform passkeys', async () => {
    spyOn(platformModule, 'getPlatform').mockReturnValue('macos')
    const version = spyOn(os, 'version').mockReturnValue('12.7.6')
    await withPasskeyRpId('app.thunderbolt.io', () => expect(isPasskeyCapable()).toBe(false))
    version.mockReturnValue('13.0.0')
    await withPasskeyRpId('app.thunderbolt.io', () => expect(isPasskeyCapable()).toBe(true))
  })

  it('needs Android 9 for Credential Manager passkeys', async () => {
    spyOn(platformModule, 'getPlatform').mockReturnValue('android')
    const version = spyOn(os, 'version').mockReturnValue('8.1.0')
    await withPasskeyRpId('app.thunderbolt.io', () => expect(isPasskeyCapable()).toBe(false))
    version.mockReturnValue('9')
    await withPasskeyRpId('app.thunderbolt.io', () => expect(isPasskeyCapable()).toBe(true))
    await withPasskeyRpId('passkeys.example.com', () => expect(isPasskeyCapable()).toBe(false))
  })

  it('needs Windows 10 1903 for webauthn.dll', async () => {
    spyOn(platformModule, 'getPlatform').mockReturnValue('windows')
    const version = spyOn(os, 'version').mockReturnValue('10.0.17763')
    await withPasskeyRpId('app.thunderbolt.io', () => expect(isPasskeyCapable()).toBe(false))
    version.mockReturnValue('10.0.18362')
    await withPasskeyRpId('app.thunderbolt.io', () => expect(isPasskeyCapable()).toBe(true))
    version.mockReturnValue('10.0.26100')
    await withPasskeyRpId('app.thunderbolt.io', () => expect(isPasskeyCapable()).toBe(true))
    await withPasskeyRpId('passkeys.example.com', () => expect(isPasskeyCapable()).toBe(false))
  })

  it('is false on the Tauri platforms without a native bridge', () => {
    spyOn(platformModule, 'getPlatform').mockReturnValue('linux')
    expect(isPasskeyCapable()).toBe(false)
  })
})

describe('native ceremonies on the Apple apps', () => {
  type NativeRequest = { request: { prfSalt: number[]; allowCredentials?: number[][] } }
  const assertion = {
    id: 'cred-auth',
    rawId: 'cred-auth',
    clientDataJson: 'cdj',
    authenticatorData: 'ad',
    signature: 'sig',
    userHandle: '',
    prfOutput: 'BQUF',
  }

  /** Route ceremonies to the native bridge and capture what it is asked for. */
  const useNativeBridge = () => {
    spyOn(platformModule, 'getPlatform').mockReturnValue('macos')
    spyOn(os, 'version').mockReturnValue('15.1.0')
    const invoke = spyOn(tauriCore, 'invoke').mockResolvedValue(assertion)
    invoke.mockClear()
    return invoke
  }

  it('discards a native assertion completed after cancellation without sending verification', async () => {
    const nativeResult = Promise.withResolvers<typeof assertion>()
    const invoke = useNativeBridge().mockReturnValueOnce(nativeResult.promise)
    const authClient = makeAuthClient([{ data: { challenge: 'abc', rpId: 'app.thunderbolt.io' } }])
    const controller = new AbortController()
    const result = signInWithPasskey(authClient, { signal: controller.signal }).catch((error: unknown) => error)
    await getClock().tickAsync(0)
    expect(invoke).toHaveBeenCalledTimes(1)
    controller.abort()
    nativeResult.resolve(assertion)
    expect(await result).toMatchObject({ name: 'AbortError' })
    expect(authClient.calls.map(({ path }) => path)).toEqual(['/passkey/generate-authenticate-options'])
    expect(authClient.$store.atoms.session.set).not.toHaveBeenCalled()
  })

  it('never asks for a PRF output on sign-in, whatever the server requests', async () => {
    const invoke = useNativeBridge()
    const authClient = makeAuthClient([
      { data: { challenge: 'abc', rpId: 'app.thunderbolt.io', extensions: { prf: { eval: { first: 'x' } } } } },
      { data: acceptedSession },
    ])

    await signInWithPasskey(authClient)

    const [, args] = invoke.mock.calls[0] as [string, NativeRequest]
    expect(args.request.prfSalt).toEqual([])
    expect(authClient.calls[1]?.options.body).toEqual({
      response: expect.objectContaining({ id: 'cred-auth', clientExtensionResults: {} }),
    })
  })

  it('asks the given passkey for its PRF output under the configured RP ID', async () => {
    const invoke = useNativeBridge()

    await withPasskeyRpId('app.thunderbolt.io', async () => {
      expect(await getPasskeyPrfOutput('AQID')).toEqual(new Uint8Array([5, 5, 5]))
    })

    const [command, args] = invoke.mock.calls[0] as [string, NativeRequest & { request: { rpId: string } }]
    expect(command).toBe('plugin:passkey|authenticate')
    expect(args.request.rpId).toBe('app.thunderbolt.io')
    expect(args.request.allowCredentials).toEqual([[1, 2, 3]])
    expect(args.request.prfSalt.length).toBeGreaterThan(0)
  })
})
