/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from 'bun:test'
import { createLargeFixture, validateLargeFixtureOptions } from './large-fixture'

const options = { chats: 4, messagesPerChat: 4, longChats: 2, longMessages: 8 }

test('fixture identity, parent chains and checkpoint ordering remain deterministic', () => {
  const fixture = createLargeFixture(options)
  expect(createLargeFixture(options).metadata).toEqual(fixture.metadata)
  expect(fixture.metadata.totalMessages).toBe(32)
  expect(fixture.metadata.totalChats).toBe(7)
  const rows = [...fixture.tables.chat_threads, ...fixture.tables.chat_messages, ...fixture.tables.models]
  expect(new Set(rows.map(({ id }) => id)).size).toBe(rows.length)
  for (const thread of fixture.tables.chat_threads) {
    const messages = fixture.tables.chat_messages.filter((message) => message.chatThreadId === thread.id)
    messages.forEach((message, index) => {
      expect(message.parentId).toBe(messages[index - 1]?.id ?? null)
      expect(message.id < fixture.checkpoint.id).toBe(true)
    })
  }
  for (const thread of fixture.longChats) {
    const last = fixture.tables.chat_messages.filter((message) => message.chatThreadId === thread.id).at(-1)!
    expect(last.role).toBe('assistant')
    expect(last.content).toContain(thread.finalHeading)
  }
})

test('rejects ID collisions, odd long histories and unsafe total allocation before building rows', () => {
  for (const change of [
    { chats: 0 },
    { longChats: NaN },
    { longMessages: 3 },
    { messagesPerChat: 10001 },
    { chats: 10000 },
    { chats: 1000, messagesPerChat: 1000 },
  ]) {
    expect(() => validateLargeFixtureOptions({ ...options, ...change })).toThrow()
  }
})
