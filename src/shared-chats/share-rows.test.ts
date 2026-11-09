/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { titleCacheKey, toReceivedShareSummary, toSentShare, withTitles } from './share-rows'

const receivedRow = (id: string, updatedAt = '2026-11-08T10:00:00.000Z') => ({
  id,
  userId: 'bob',
  ownerUserId: 'alice',
  ownerName: 'Alice',
  ownerEmail: 'alice@example.com',
  encryptedTitle: `title-${id}`,
  sealedShareKey: `key-${id}`,
  inboxVersion: 2,
  updatedAt,
})

describe('toSentShare', () => {
  it('keeps everything but the owner column', () => {
    const recipients = [{ userId: 'bob', name: 'Bob', email: 'bob@example.com' }]
    expect(
      toSentShare({
        id: 's',
        userId: 'alice',
        chatThreadId: 't',
        recipients,
        version: 3,
        updatedAt: '2026-11-08T10:00:00.000Z',
      }),
    ).toEqual({ id: 's', chatThreadId: 't', recipients, version: 3, updatedAt: '2026-11-08T10:00:00.000Z' })
  })
})

describe('toReceivedShareSummary', () => {
  it('nests the owner and keeps the name and email apart', () => {
    expect(toReceivedShareSummary(receivedRow('s'))).toEqual({
      id: 's',
      updatedAt: '2026-11-08T10:00:00.000Z',
      owner: { userId: 'alice', name: 'Alice', email: 'alice@example.com' },
      encryptedTitle: 'title-s',
      sealedShareKey: 'key-s',
      inboxVersion: 2,
    })
  })
})

describe('titleCacheKey', () => {
  it('changes when the share is replaced', () => {
    const before = toReceivedShareSummary(receivedRow('s'))
    const after = toReceivedShareSummary(receivedRow('s', '2026-11-08T11:00:00.000Z'))
    expect(titleCacheKey(before)).not.toBe(titleCacheKey(after))
  })
})

describe('withTitles', () => {
  const shares = [toReceivedShareSummary(receivedRow('a')), toReceivedShareSummary(receivedRow('b'))]

  it('adds each title, null for one this device cannot open', () => {
    const titles = new Map([
      ['a', 'Trip plans'],
      ['b', null],
    ])
    expect(withTitles(shares, titles, false).map(({ id, title }) => [id, title])).toEqual([
      ['a', 'Trip plans'],
      ['b', null],
    ])
  })

  it('shows every share without a title when titles could not be loaded', () => {
    expect(withTitles(shares, undefined, false).map(({ id, title }) => [id, title])).toEqual([
      ['a', undefined],
      ['b', undefined],
    ])
  })

  it('holds back a new share until its title is decrypted, rather than showing it as unreadable', () => {
    const previous = new Map([['a', 'Trip plans']])
    expect(withTitles(shares, previous, true).map(({ id }) => id)).toEqual(['a'])
  })

  it('never hides shares when there are no titles at all', () => {
    expect(withTitles(shares, undefined, true).map(({ id }) => id)).toEqual(['a', 'b'])
  })
})
