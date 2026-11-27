/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import type { ThunderboltUIMessage } from '@/types'
import { findLatestResponseId } from './latest-response'

const user: ThunderboltUIMessage = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Hi' }] }
const assistant = (id: string, overrides: Partial<ThunderboltUIMessage> = {}): ThunderboltUIMessage => ({
  id,
  role: 'assistant',
  parts: [{ type: 'text', text: 'Hello' }],
  ...overrides,
})

describe('findLatestResponseId', () => {
  it('is undefined before any response', () => {
    expect(findLatestResponseId([])).toBeUndefined()
    expect(findLatestResponseId([user])).toBeUndefined()
  })

  it('picks the newest response, even with a user message after it', () => {
    expect(findLatestResponseId([user, assistant('a1'), user, assistant('a2'), user])).toBe('a2')
  })

  it('skips an empty assistant shell and the hidden OAuth retry turn', () => {
    const messages = [
      user,
      assistant('a1'),
      assistant('empty', { parts: [] }),
      assistant('retry', { metadata: { oauthRetry: true } }),
    ]
    expect(findLatestResponseId(messages)).toBe('a1')
  })
})
