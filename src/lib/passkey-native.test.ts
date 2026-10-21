/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import * as tauriCore from '@tauri-apps/api/core'
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { isPasskeyCancellation } from './passkey'
import { authenticatePasskeyNative, registerPasskeyNative } from './passkey-native'

const salt = new Uint8Array([1, 2, 3])

// Cleared too: a spy re-created on the same export can keep calls from another file.
const stubInvoke = (result: Record<string, string>) => {
  const invoke = spyOn(tauriCore, 'invoke').mockResolvedValue(result)
  invoke.mockClear()
  return invoke
}

afterEach(() => {
  mock.restore()
})

describe('registerPasskeyNative', () => {
  const options = {
    rp: { id: 'app.example.com', name: 'App' },
    user: { id: 'AQID', name: 'ada@example.com', displayName: 'Ada' },
    challenge: 'BAUG',
    pubKeyCredParams: [],
    excludeCredentials: [{ id: '-_8', type: 'public-key' as const }],
  }

  it('sends decoded bytes and keeps the PRF output out of the response', async () => {
    const invoke = stubInvoke({
      id: 'cred',
      rawId: 'cred',
      clientDataJson: 'cdj',
      attestationObject: 'att',
      prfOutput: 'BQUF',
    })

    const { response, prfOutput } = await registerPasskeyNative(options, salt)

    expect(invoke).toHaveBeenCalledWith('plugin:passkey|register', {
      request: {
        rpId: 'app.example.com',
        challenge: [4, 5, 6],
        userId: [1, 2, 3],
        userName: 'ada@example.com',
        excludeCredentials: [[0xfb, 0xff]],
        prfSalt: [1, 2, 3],
      },
    })
    expect(prfOutput).toEqual(new Uint8Array([5, 5, 5]))
    expect(response.clientExtensionResults).toEqual({})
    expect(response.response.attestationObject).toBe('att')
  })

  it('returns no PRF output when the provider has none', async () => {
    stubInvoke({ id: 'cred', rawId: 'cred', clientDataJson: 'cdj', attestationObject: 'att', prfOutput: '' })

    const { prfOutput } = await registerPasskeyNative(options, salt)

    expect(prfOutput).toBeNull()
  })

  it('refuses to run without an RP ID, which the native API requires', async () => {
    const invoke = stubInvoke({})

    await expect(registerPasskeyNative({ ...options, rp: { name: 'App' } }, salt)).rejects.toThrow('needs an RP ID')
    expect(invoke).not.toHaveBeenCalled()
  })
})

describe('authenticatePasskeyNative', () => {
  const assertion = {
    id: 'cred',
    rawId: 'cred',
    clientDataJson: 'cdj',
    authenticatorData: 'ad',
    signature: 'sig',
    userHandle: '',
    prfOutput: '',
  }

  it('decodes unpadded base64url with the URL-safe alphabet', async () => {
    const invoke = stubInvoke(assertion)

    await authenticatePasskeyNative({ challenge: '-_-_8A', rpId: 'app.example.com' }, new Uint8Array())

    const [, args] = invoke.mock.calls[0] as [string, { request: { challenge: number[] } }]
    expect(args.request.challenge).toEqual([0xfb, 0xff, 0xbf, 0xf0])
  })

  it('limits the prompt to the allowed credentials', async () => {
    const invoke = stubInvoke(assertion)

    const { response } = await authenticatePasskeyNative(
      { challenge: 'BAUG', rpId: 'app.example.com', allowCredentials: [{ id: 'AQID', type: 'public-key' }] },
      new Uint8Array(),
    )

    expect(invoke).toHaveBeenCalledWith('plugin:passkey|authenticate', {
      request: { rpId: 'app.example.com', challenge: [4, 5, 6], allowCredentials: [[1, 2, 3]], prfSalt: [] },
    })
    expect(response.response.userHandle).toBeUndefined()
  })

  it('refuses to run without an RP ID, which the native API requires', async () => {
    const invoke = stubInvoke(assertion)

    await expect(authenticatePasskeyNative({ challenge: 'BAUG' }, salt)).rejects.toThrow('needs an RP ID')
    expect(invoke).not.toHaveBeenCalled()
  })
})

describe('native ceremony errors', () => {
  const options = { challenge: 'BAUG', rpId: 'app.example.com' }
  const reject = (error: unknown) => spyOn(tauriCore, 'invoke').mockRejectedValue(error)

  it('turns a dismissed sheet into the cancellation a browser ceremony throws', async () => {
    reject({ code: 'cancelled', message: 'passkey ceremony cancelled' })

    const error = await authenticatePasskeyNative(options, salt).catch((caught: unknown) => caught)

    expect(isPasskeyCancellation(error)).toBe(true)
  })

  it('keeps a failure an error, whatever its OS message says', async () => {
    reject({ code: 'failed', message: 'passkey ceremony failed: The operation was canceled.' })

    const error = await authenticatePasskeyNative(options, salt).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(Error)
    expect(isPasskeyCancellation(error)).toBe(false)
    expect((error as Error).message).toBe('passkey ceremony failed: The operation was canceled.')
  })

  it('turns a rejection from Tauri itself into an error', async () => {
    reject('passkey.authenticate not allowed')

    const error = await authenticatePasskeyNative(options, salt).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('passkey.authenticate not allowed')
  })
})
