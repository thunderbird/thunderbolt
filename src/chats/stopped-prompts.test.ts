/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'

import { describe, expect, it } from 'bun:test'
import { prepareBuiltInConversation } from '@/acp/built-in-conversation'
import type { ThunderboltUIMessage } from '@/types'
import { stoppedReplyMarker } from '@shared/agent-core/stopped-reply'
import { withStoppedReplyMarkers } from './stopped-prompts'

const user = (id: string, text: string, stoppedByUser?: boolean): ThunderboltUIMessage => ({
  id,
  role: 'user',
  parts: [{ type: 'text', text }],
  metadata: { stoppedByUser },
})

const assistant = (id: string, parts: ThunderboltUIMessage['parts']): ThunderboltUIMessage => ({
  id,
  role: 'assistant',
  parts,
})

const essayPrompt = 'Write a long essay about Lisbon.'
const question = 'Which city do I live in?'
const opening = [user('u1', 'I live in Lisbon.'), assistant('a1', [{ type: 'text', text: 'Noted.' }])]

const replyTexts = (messages: ThunderboltUIMessage[]) =>
  messages.map((message) => message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join(''))

describe('withStoppedReplyMarkers', () => {
  it('answers a prompt stopped before any reply with the marker', () => {
    const messages = [...opening, user('u2', essayPrompt, true), user('u3', question)]

    expect(replyTexts(withStoppedReplyMarkers(messages))).toEqual([
      'I live in Lisbon.',
      'Noted.',
      essayPrompt,
      stoppedReplyMarker,
      question,
    ])
  })

  it('adds the marker after a stopped reply that had no text', () => {
    const reasoningOnly = assistant('a2', [{ type: 'step-start' }, { type: 'reasoning', text: 'Planning…' }])
    const messages = [...opening, user('u2', essayPrompt, true), reasoningOnly, user('u3', question)]

    const marked = withStoppedReplyMarkers(messages)

    expect(marked.map((message) => message.id)).toEqual(['u1', 'a1', 'u2', 'a2', 'u2-stopped', 'u3'])
  })

  it('leaves a stopped reply alone when the user saw part of its text', () => {
    const partial = assistant('a2', [{ type: 'text', text: 'Lisbon grew up on seven hills' }])
    const messages = [...opening, user('u2', essayPrompt, true), partial, user('u3', question)]

    expect(withStoppedReplyMarkers(messages)).toEqual(messages)
  })

  it('leaves a prompt alone when its request failed instead of being stopped', () => {
    const messages = [...opening, user('u2', essayPrompt), user('u3', question)]

    expect(withStoppedReplyMarkers(messages)).toEqual(messages)
  })

  it('never marks the prompt being sent', () => {
    const messages = [...opening, user('u2', essayPrompt, true)]

    expect(withStoppedReplyMarkers(messages)).toEqual(messages)
  })

  it('keeps the stopped prompt out of the prompt sent to the built-in agent', async () => {
    const messages = [...opening, user('u2', essayPrompt, true), user('u3', question)]

    const { history, prompt } = await prepareBuiltInConversation(withStoppedReplyMarkers(messages), undefined)

    expect(prompt.text).toBe(question)
    expect(history.at(-1)).toEqual({ role: 'assistant', text: stoppedReplyMarker })
  })
})
