/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { type ReplyChat, createChatReply } from './chat-reply'

// The happydom test env doesn't run real `setTimeout`, so stream + poll on
// microtasks: the fake appends a token per microtask, and we inject a microtask
// `wait` into createChatReply.
const microtask = () => Promise.resolve()

type MutableMessage = { role: string; parts: Array<{ type: string; text: string }> }

/**
 * A fake `Chat` that streams `tokens` into a NEW assistant message over
 * microtasks — and seeds a stale prior assistant message, so tests catch the
 * "reads the previous turn" bug.
 */
const makeFakeChat = (tokens: string[]) => {
  const state = {
    messages: [{ role: 'assistant', parts: [{ type: 'text', text: 'stale previous reply' }] }] as MutableMessage[],
    stopped: false,
  }
  const chat: ReplyChat = {
    get messages() {
      return state.messages
    },
    stop: async () => {
      state.stopped = true
    },
    sendMessage: async () => {
      state.messages.push({ role: 'user', parts: [{ type: 'text', text: 'ignored' }] })
      const part = { type: 'text', text: '' }
      state.messages.push({ role: 'assistant', parts: [part] })
      for (const token of tokens) {
        if (state.stopped) {
          break
        }
        await microtask()
        part.text += token
      }
    },
  }
  return { chat, state }
}

const collect = async (iter: AsyncIterable<string>): Promise<string[]> => {
  const out: string[] = []
  for await (const chunk of iter) {
    out.push(chunk)
  }
  return out
}

describe('createChatReply', () => {
  test('streams the assistant text and reassembles it fully', async () => {
    const { chat } = makeFakeChat(['Hello', ', ', 'there', '.'])
    const reply = createChatReply(chat, microtask)
    const chunks = await collect(reply('hi', new AbortController().signal))
    expect(chunks.join('')).toBe('Hello, there.')
  })

  test('stops the chat and ends early on abort (turn supersede / stop)', async () => {
    const { chat, state } = makeFakeChat(['one ', 'two ', 'three ', 'four ', 'five'])
    const ac = new AbortController()
    const reply = createChatReply(chat, microtask)
    const chunks: string[] = []
    for await (const chunk of reply('go', ac.signal)) {
      chunks.push(chunk)
      ac.abort() // abort as soon as we get audio
    }
    expect(state.stopped).toBe(true)
    expect(chunks.join('')).not.toContain('five')
  })

  test('empty assistant reply yields nothing', async () => {
    const { chat } = makeFakeChat([])
    const reply = createChatReply(chat, microtask)
    const chunks = await collect(reply('hi', new AbortController().signal))
    expect(chunks).toEqual([])
  })

  test('surfaces a sendMessage failure by throwing (not a silent empty turn)', async () => {
    const chat: ReplyChat = {
      messages: [],
      stop: async () => {},
      sendMessage: async () => {
        throw new Error('network down')
      },
    }
    const reply = createChatReply(chat, microtask)
    await expect(collect(reply('hi', new AbortController().signal))).rejects.toThrow('network down')
  })

  test('does not throw when the failure is our own abort', async () => {
    const { chat } = makeFakeChat(['one ', 'two ', 'three'])
    const ac = new AbortController()
    const reply = createChatReply(chat, microtask)
    // Aborting rejects the in-flight send via chat.stop(); that must not surface
    // as a turn error.
    for await (const _ of reply('go', ac.signal)) {
      ac.abort()
    }
    // Reaching here without throwing is the assertion.
  })
})
