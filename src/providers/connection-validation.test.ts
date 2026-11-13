/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import * as privatemode from '@/ai/privatemode-client'
import { asAttestationFailure } from '@/attestation/errors'
import { HttpError } from '@/lib/http'
import { validateProviderConnectionCredentials } from './connection-validation'

afterEach(() => mock.restore())

describe('provider credential validation', () => {
  test('does not probe providers without a registered credential proof', async () => {
    const validate = spyOn(privatemode, 'validatePrivatemodeApiKey')
    await validateProviderConnectionCredentials({
      provider: 'openrouter',
      apiKey: 'key',
      signal: new AbortController().signal,
    })
    expect(validate).not.toHaveBeenCalled()
  })

  test('calls the selected provider proof with the supplied key and bounded signal', async () => {
    const validate = spyOn(privatemode, 'validatePrivatemodeApiKey').mockResolvedValue()
    await validateProviderConnectionCredentials({
      provider: 'privatemode',
      apiKey: 'key',
      signal: new AbortController().signal,
    })
    expect(validate).toHaveBeenCalledWith('key', expect.any(AbortSignal))
  })

  test.each([
    ['credentials', new HttpError(new Response(null, { status: 401 }))],
    ['credentials', asAttestationFailure(Object.assign(new Error('redacted'), { status: 403 }))],
    ['credentials', Object.assign(new Error('redacted'), { statusCode: 401 })],
    ['timeout', new DOMException('expired', 'TimeoutError')],
    ['timeout', Object.assign(new Error('expired'), { name: 'PrivatemodeAttestationTimeoutError' })],
    ['attestation', asAttestationFailure(new Error('measurement rejected'))],
    ['connection', asAttestationFailure(new TypeError('Failed to fetch'))],
    ['connection', new HttpError(new Response(null, { status: 503 }))],
  ] as const)('classifies %s without exposing vendor details', async (kind, failure) => {
    spyOn(privatemode, 'validatePrivatemodeApiKey').mockRejectedValue(failure)
    await expect(
      validateProviderConnectionCredentials({
        provider: 'privatemode',
        apiKey: 'key',
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ kind, message: 'Provider connection validation failed' })
  })

  test('rejects an already-cancelled operation without invoking a provider', async () => {
    const validate = spyOn(privatemode, 'validatePrivatemodeApiKey')
    const reason = new Error('identity ended')
    await expect(
      validateProviderConnectionCredentials({
        provider: 'privatemode',
        apiKey: 'key',
        signal: AbortSignal.abort(reason),
      }),
    ).rejects.toBe(reason)
    expect(validate).not.toHaveBeenCalled()
  })

  test.each(['cancelled', 'timeout'] as const)('bounds an adapter that ignores its %s signal', async (kind) => {
    const started = Promise.withResolvers<void>()
    const pending = Promise.withResolvers<void>()
    const controller = new AbortController()
    const deadline = new AbortController()
    spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
    spyOn(privatemode, 'validatePrivatemodeApiKey').mockImplementation(async () => {
      started.resolve()
      await pending.promise
    })
    const validation = validateProviderConnectionCredentials({
      provider: 'privatemode',
      apiKey: 'key',
      signal: controller.signal,
    })
    await started.promise
    const reason = new DOMException('operation ended', kind === 'timeout' ? 'TimeoutError' : 'AbortError')
    if (kind === 'timeout') {
      deadline.abort(reason)
      await expect(validation).rejects.toMatchObject({ kind: 'timeout' })
    } else {
      controller.abort(reason)
      await expect(validation).rejects.toBe(reason)
    }
    pending.resolve()
  })
})
