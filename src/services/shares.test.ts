/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { HttpError } from '@/lib/http'
import { describe, expect, it } from 'bun:test'
import {
  ChatNotSyncedError,
  RecipientUnavailableError,
  ShareChangedElsewhereError,
  type ShareableRecipient,
  storeWithReseal,
  assertRecipientChanged,
  isShareGone,
} from './shares'

const httpError = (status: number, body: unknown = {}) =>
  new HttpError(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))

const recipient = (email: string, inboxVersion = 1): ShareableRecipient => ({
  email,
  status: 'ok',
  userId: `id-${email}`,
  inboxVersion,
  ecdhPublicKey: 'ecdh',
  mlkemPublicKey: 'mlkem',
})

describe('assertRecipientChanged', () => {
  it('asks for a fresh lookup when a recipient’s inbox key changed', async () => {
    expect(await assertRecipientChanged(httpError(409, { code: 'RECIPIENT_CHANGED' }))).toBeUndefined()
  })

  it.each(['CHAT_ALREADY_SHARED', 'SHARE_CHANGED', 'SHARE_ID_TAKEN'])(
    'reports %s as shared from elsewhere',
    async (code) => {
      await expect(assertRecipientChanged(httpError(409, { code }))).rejects.toBeInstanceOf(ShareChangedElsewhereError)
    },
  )

  it('reports a chat the server does not have as not synced yet', async () => {
    await expect(assertRecipientChanged(httpError(404, { code: 'CHAT_NOT_FOUND' }))).rejects.toBeInstanceOf(
      ChatNotSyncedError,
    )
  })

  it.each([
    ['a 404 from the device gate', httpError(404, { error: 'Device not found' })],
    ['a 409 without a code', httpError(409)],
    ['a server error', httpError(500)],
    ['a network failure', new TypeError('fetch failed')],
  ])('rethrows %s as itself', async (_, error) => {
    await expect(assertRecipientChanged(error)).rejects.toBe(error)
  })
})

describe('storeWithReseal', () => {
  it('stores once when nothing changed', async () => {
    const stored: ShareableRecipient[][] = []
    await storeWithReseal(
      async (to) => {
        stored.push(to)
      },
      async () => {
        throw new Error('no lookup expected')
      },
      [recipient('ada@example.com')],
    )
    expect(stored).toEqual([[recipient('ada@example.com')]])
  })

  it('reseals to the fresh inbox keys after a recipient changed', async () => {
    const stored: ShareableRecipient[][] = []
    const fresh = [recipient('ada@example.com', 2)]
    await storeWithReseal(
      async (to) => {
        stored.push(to)
        if (stored.length === 1) {
          throw httpError(409, { code: 'RECIPIENT_CHANGED' })
        }
      },
      async () => fresh,
      [recipient('ada@example.com')],
    )
    expect(stored).toEqual([[recipient('ada@example.com')], fresh])
  })

  it('fails with the person who can no longer receive shares', async () => {
    const lookupError = new RecipientUnavailableError('ada@example.com')
    await expect(
      storeWithReseal(
        async () => {
          throw httpError(409, { code: 'RECIPIENT_CHANGED' })
        },
        async () => {
          throw lookupError
        },
        [recipient('ada@example.com')],
      ),
    ).rejects.toBe(lookupError)
  })

  it('maps a failure on the reseal too, rather than leaking a raw 404', async () => {
    const calls: number[] = []
    await expect(
      storeWithReseal(
        async () => {
          calls.push(calls.length)
          throw calls.length === 1
            ? httpError(409, { code: 'RECIPIENT_CHANGED' })
            : httpError(404, { code: 'CHAT_NOT_FOUND' })
        },
        async (to) => to,
        [recipient('ada@example.com')],
      ),
    ).rejects.toBeInstanceOf(ChatNotSyncedError)
  })

  it('gives up after a second change instead of looping', async () => {
    const lookups: number[] = []
    await expect(
      storeWithReseal(
        async () => {
          throw httpError(409, { code: 'RECIPIENT_CHANGED' })
        },
        async (to) => {
          lookups.push(lookups.length)
          return to
        },
        [recipient('ada@example.com')],
      ),
    ).rejects.toThrow('changed again')
    expect(lookups).toHaveLength(1)
  })
})

describe('isShareGone', () => {
  it('is true for a 404 naming the share or person as gone', async () => {
    expect(await isShareGone(httpError(404, { code: 'SHARE_NOT_FOUND' }))).toBe(true)
  })

  it.each([
    ['the device gate’s 404', httpError(404, { error: 'Device not found' })],
    ['a 404 for a chat not synced', httpError(404, { code: 'CHAT_NOT_FOUND' })],
    ['a server error', httpError(500, { code: 'SHARE_NOT_FOUND' })],
    ['a network failure', new TypeError('fetch failed')],
  ])('is false for %s', async (_, error) => {
    expect(await isShareGone(error)).toBe(false)
  })
})
