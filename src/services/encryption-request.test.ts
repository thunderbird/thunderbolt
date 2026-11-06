/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock } from 'bun:test'
import { createClient, HttpError } from '@/lib/http'
import { getClock } from '@/testing-library'
import { createEncryptionOperationClient, EncryptionRequestTimeoutError } from './encryption-request'

const noChange = () => {}

describe('encryption request ownership', () => {
  it('bounds response headers even when transport ignores cancellation', async () => {
    const transport = Promise.withResolvers<Response>()
    let signal: AbortSignal | undefined
    const client = createClient({
      fetch: async (input) => {
        signal = (input as Request).signal
        return transport.promise
      },
    })
    const scoped = createEncryptionOperationClient(client, new AbortController().signal, noChange)
    const result = scoped
      .get('https://api.test/keys')
      .json()
      .then(
        () => null,
        (error: unknown) => error,
      )
    await getClock().tickAsync(10_000)
    expect(await result).toBeInstanceOf(EncryptionRequestTimeoutError)
    expect(signal?.aborted).toBe(true)
    transport.reject(new Error('late transport failure'))
    await Promise.resolve()
  })

  it('bounds body parsing after headers have arrived and observes a late body failure', async () => {
    let body!: ReadableStreamDefaultController<Uint8Array>
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          body = controller
        },
      }),
    )
    const scoped = createEncryptionOperationClient(
      createClient({ fetch: async () => response }),
      new AbortController().signal,
      noChange,
    )
    const result = scoped
      .get('https://api.test/keys')
      .json()
      .then(
        () => null,
        (error: unknown) => error,
      )
    await getClock().tickAsync(10_000)
    expect(await result).toBeInstanceOf(EncryptionRequestTimeoutError)
    body.error(new Error('late body failure'))
    await Promise.resolve()
  })

  it('bounds a step-up refusal body before exposing HttpError to downstream handlers', async () => {
    let body!: ReadableStreamDefaultController<Uint8Array>
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          body = controller
        },
      }),
      { status: 403 },
    )
    const scoped = createEncryptionOperationClient(
      createClient({ fetch: async () => response }),
      new AbortController().signal,
      noChange,
    )
    const result = scoped
      .post('https://api.test/rotate')
      .json()
      .then(
        () => null,
        (error: unknown) => error,
      )
    await getClock().tickAsync(10_000)
    expect(await result).toBeInstanceOf(EncryptionRequestTimeoutError)
    body.error(new Error('late refusal body failure'))
    await Promise.resolve()
  })

  it('preserves a bounded refusal body for ordinary HttpError response parsers', async () => {
    const scoped = createEncryptionOperationClient(
      createClient({ fetch: async () => Response.json({ code: 'step_up_invalid' }, { status: 403 }) }),
      new AbortController().signal,
      noChange,
    )
    const error = await scoped
      .post('https://api.test/rotate')
      .json()
      .then(
        () => null,
        (error: unknown) => error,
      )
    expect(error).toBeInstanceOf(HttpError)
    if (!(error instanceof HttpError)) {
      throw new Error('Expected HttpError')
    }
    expect(await error.response.json()).toEqual({ code: 'step_up_invalid' })
    expect(getClock().countTimers()).toBe(0)
  })

  it('cancels a pending body immediately when account cleanup starts', async () => {
    const lifetime = new AbortController()
    const response = new Response(new ReadableStream<Uint8Array>())
    const scoped = createEncryptionOperationClient(
      createClient({ fetch: async () => response }),
      lifetime.signal,
      noChange,
    )
    const result = scoped
      .get('https://api.test/keys')
      .text()
      .then(
        () => null,
        (error: unknown) => error,
      )
    lifetime.abort(new Error('account reset'))
    expect(await result).toMatchObject({ message: 'account reset' })
  })

  it('checks ownership after parsing and clears completed request timers', async () => {
    const assertCurrent = mock(noChange)
    const scoped = createEncryptionOperationClient(
      createClient({ fetch: async () => Response.json({ ready: true }) }),
      new AbortController().signal,
      assertCurrent,
    )
    expect(await scoped.get('https://api.test/keys').json<{ ready: boolean }>()).toEqual({ ready: true })
    expect(assertCurrent.mock.calls.length).toBe(3)
    expect(getClock().countTimers()).toBe(0)
  })
})
