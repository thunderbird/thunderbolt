/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { v7 as uuidv7 } from 'uuid'
import { detectChatImport, rekeyChat } from './chat-import'

const thread = { id: 'thread-1', title: 'Trip plan', projectId: 'project-1', acpSessionId: 'session-1' }
const messages = [
  { id: 'm1', chatThreadId: 'thread-1', parentId: null },
  { id: 'm2', chatThreadId: 'thread-1', parentId: 'm1' },
]

describe('detectChatImport', () => {
  it('recognises one thread with its own messages', () => {
    expect(detectChatImport({ chat_threads: [thread], chat_messages: messages }, undefined)).toEqual({
      title: 'Trip plan',
      messageCount: 2,
    })
  })

  it('ignores empty tables and accepts a thread without messages', () => {
    expect(detectChatImport({ chat_threads: [thread], tasks: [], settings: [] }, undefined)).toEqual({
      title: 'Trip plan',
      messageCount: 0,
    })
  })

  it('reports an untitled chat with a null title', () => {
    expect(detectChatImport({ chat_threads: [{ id: 'thread-1' }] }, undefined)?.title).toBeNull()
  })

  it('treats more than one thread as a full backup', () => {
    const tables = { chat_threads: [thread, { id: 'thread-2' }], chat_messages: messages }
    expect(detectChatImport(tables, undefined)).toBeNull()
    expect(detectChatImport(tables, 'chat')).toBeNull()
  })

  it('treats an unmarked file with rows in any other table as a full backup', () => {
    expect(detectChatImport({ chat_threads: [thread], tasks: [{ id: 'task-1' }] }, undefined)).toBeNull()
  })

  it('accepts other tables in a file marked as a chat', () => {
    expect(detectChatImport({ chat_threads: [thread], attachments: [{ id: 'file-1' }] }, 'chat')).toEqual({
      title: 'Trip plan',
      messageCount: 0,
    })
  })

  it('treats a message from another thread as a full backup', () => {
    const tables = { chat_threads: [thread], chat_messages: [...messages, { id: 'm3', chatThreadId: 'thread-2' }] }
    expect(detectChatImport(tables, 'chat')).toBeNull()
  })

  it('needs a thread with a string id', () => {
    expect(detectChatImport({ chat_messages: messages }, undefined)).toBeNull()
    expect(detectChatImport({ chat_threads: [{ title: 'No id' }] }, undefined)).toBeNull()
    expect(detectChatImport({ chat_threads: 'nope' }, undefined)).toBeNull()
  })
})

describe('rekeyChat', () => {
  const tables = { chat_threads: [thread], chat_messages: messages }
  const threadsOf = (rekeyed: Record<string, unknown>) => rekeyed.chat_threads as Array<Record<string, unknown>>
  const messagesOf = (rekeyed: Record<string, unknown>) => rekeyed.chat_messages as Array<Record<string, unknown>>

  it('derives each id from the owner and the original id', () => {
    // Pinned: a different id here means every re-import of an existing file would add a second copy.
    expect(threadsOf(rekeyChat(tables, 'user-b'))[0].id).toBe('96a10a0a-3e56-5931-8131-31c8e89f0dc7')
  })

  it('keeps the message tree under the new ids', () => {
    const rekeyed = rekeyChat(tables, 'user-b')
    const [newThread] = threadsOf(rekeyed)
    const [first, second] = messagesOf(rekeyed)

    expect(first.id).not.toBe('m1')
    expect(first.chatThreadId).toBe(newThread.id)
    expect(second.chatThreadId).toBe(newThread.id)
    expect(first.parentId).toBeNull()
    expect(second.parentId).toBe(first.id)
  })

  it('keeps uuid v7 ids in their original order, and before messages written later', () => {
    const v7Ids = [
      '019a1b2c-3d4e-7000-8000-000000000001',
      '019a1b2c-3d4e-7001-9fff-ffffffffffff',
      '019a1b2c-3d4f-7000-a123-456789abcdef',
      '019a1c00-0000-7abc-b000-000000000000',
    ]
    const v7Messages = v7Ids.map((id) => ({ id, chatThreadId: 'thread-1', parentId: null }))
    const rekeyedIds = () =>
      messagesOf(rekeyChat({ chat_threads: [thread], chat_messages: v7Messages }, 'user-b')).map((message) =>
        String(message.id),
      )
    const newIds = rekeyedIds()

    expect(newIds).toEqual([...newIds].sort())
    expect(newIds.map((id, index) => id.slice(0, 26) === v7Ids[index].slice(0, 26))).toEqual([true, true, true, true])
    expect(newIds.some((id, index) => id === v7Ids[index])).toBe(false)
    expect(newIds.every((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))).toBe(
      true,
    )
    expect(rekeyedIds()).toEqual(newIds)
    // A message written after the import gets a uuid v7 from the current time, which sorts after all of these.
    expect(newIds.every((id) => id < '019b0000-0000-7000-8000-000000000000')).toBe(true)
  })

  it('keeps the order of ids made in the same millisecond', () => {
    // The uuid library orders these by a counter that reaches into byte 10, past the first half of the id.
    const sameMillisecond = Array.from({ length: 8 }, (_, seq) => uuidv7({ msecs: 1_760_000_000_000, seq }))
    const rekeyed = messagesOf(
      rekeyChat(
        {
          chat_threads: [thread],
          chat_messages: sameMillisecond.map((id) => ({ id, chatThreadId: 'thread-1', parentId: null })),
        },
        'user-b',
      ),
    ).map((message) => String(message.id))

    expect([...sameMillisecond].sort()).toEqual(sameMillisecond)
    expect(rekeyed).toEqual([...rekeyed].sort())
  })

  it('derives different ids for different owners', () => {
    expect(threadsOf(rekeyChat(tables, 'user-b'))[0].id).not.toBe(threadsOf(rekeyChat(tables, 'user-c'))[0].id)
  })

  it("drops the other account's project and ACP session and keeps everything else", () => {
    const [newThread] = threadsOf(rekeyChat(tables, 'user-b'))
    expect(newThread).toEqual({ ...thread, id: newThread.id, projectId: null, acpSessionId: null })
  })
})
