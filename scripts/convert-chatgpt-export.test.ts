/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'

import { convertChatGptConversations } from './convert-chatgpt-export'

type TestMessage = {
  id: string
  author: { role: string }
  create_time: number
  content: { content_type: string; parts: unknown[] }
}

type TestNode = {
  id: string
  parent: string | null
  children: string[]
  message: TestMessage | null
}

type TestConversation = {
  id: string
  title: string
  create_time: number
  current_node: string
  mapping: Record<string, TestNode>
}

const message = (id: string, role: string, text: string, createTime: number, contentType = 'text') => ({
  id,
  author: { role },
  create_time: createTime,
  content: { content_type: contentType, parts: [text] as unknown[] },
})

const fixtureConversation = (currentNode = 'assistant-active'): TestConversation => ({
  id: 'source-conversation-id',
  title: 'Imported conversation',
  create_time: 1_700_000_000,
  current_node: currentNode,
  mapping: {
    root: { id: 'root', parent: null, children: ['user'], message: null },
    user: {
      id: 'user',
      parent: 'root',
      children: ['assistant-old', 'assistant-active'],
      message: message('user', 'user', 'Question', 1_700_000_001),
    },
    'assistant-old': {
      id: 'assistant-old',
      parent: 'user',
      children: [],
      message: message('assistant-old', 'assistant', 'Other branch', 1_700_000_002),
    },
    'assistant-active': {
      id: 'assistant-active',
      parent: 'user',
      children: [],
      message: message('assistant-active', 'assistant', 'Selected answer', 1_700_000_003),
    },
  },
})

const uuidTimestamp = (id: string): number => Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16)

describe('convertChatGptConversations', () => {
  it('creates a Thunderbolt backup with the selected conversation path and linked messages', () => {
    const result = convertChatGptConversations([fixtureConversation()], new Date('2026-01-02T03:04:05.000Z'))
    const { export: converted, stats } = result
    const [thread] = converted.tables.chat_threads
    const [userMessage, assistantMessage] = converted.tables.chat_messages

    expect(converted).toMatchObject({
      format: 'thunderbolt-export',
      schemaVersion: 1,
      exportedAt: '2026-01-02T03:04:05.000Z',
      tables: { chat_threads: [{ title: 'Imported conversation' }] },
    })
    expect(userMessage).toMatchObject({
      role: 'user',
      content: 'Question',
      parts: [{ type: 'text', text: 'Question' }],
      chatThreadId: thread?.id,
      parentId: null,
    })
    expect(assistantMessage).toMatchObject({
      role: 'assistant',
      content: 'Selected answer',
      chatThreadId: thread?.id,
      parentId: userMessage?.id,
    })
    expect(converted.tables.chat_messages.map(({ id }) => uuidTimestamp(id))).toEqual([
      1_700_000_001_000, 1_700_000_003_000,
    ])
    expect(stats).toEqual({
      inputConversations: 1,
      importedConversations: 1,
      importedMessages: 2,
      omittedMessages: 0,
      unselectedNodes: 1,
    })
  })

  it('omits hidden reasoning and selects the newest leaf when current_node is missing', () => {
    const conversation = fixtureConversation('')
    conversation.mapping['assistant-active'].children = ['thoughts', 'final']
    conversation.mapping['assistant-active'].message = message(
      'assistant-active',
      'assistant',
      'Private reasoning',
      1_700_000_003,
      'thoughts',
    )
    conversation.mapping['thoughts'] = {
      id: 'thoughts',
      parent: 'assistant-active',
      children: ['final'],
      message: message('thoughts', 'assistant', 'Hidden reasoning', 1_700_000_004, 'thoughts'),
    }
    conversation.mapping.final = {
      id: 'final',
      parent: 'thoughts',
      children: [],
      message: message('final', 'assistant', 'Visible answer', 1_700_000_005),
    }

    const result = convertChatGptConversations([conversation])

    expect(result.export.tables.chat_messages.map(({ content }) => content)).toEqual(['Question', 'Visible answer'])
    expect(result.export.tables.chat_messages[1]?.parentId).toBe(result.export.tables.chat_messages[0]?.id)
    expect(result.stats.omittedMessages).toBe(2)
  })

  it('keeps readable text from multimodal messages and ignores non-text parts', () => {
    const conversation = fixtureConversation()
    conversation.mapping.user.message = {
      ...message('user', 'user', '', 1_700_000_001, 'multimodal_text'),
      content: {
        content_type: 'multimodal_text',
        parts: ['Look at this ', { content_type: 'image_asset_pointer', asset_pointer: 'omitted' }],
      },
    }

    const result = convertChatGptConversations([conversation])

    expect(result.export.tables.chat_messages[0]).toMatchObject({
      content: 'Look at this ',
      parts: [{ type: 'text', text: 'Look at this ' }],
    })
  })

  it('rejects malformed conversations instead of silently producing a partial import', () => {
    expect(() => convertChatGptConversations([{ title: 'No mapping' }])).toThrow(
      'Conversation 1 is missing its message mapping.',
    )
  })
})
