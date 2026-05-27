/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'

import type { ThunderboltUIMessage } from '@/types'
import { extractLastUserText, resolveSkillTokenInstructions } from './resolve-skill-system-messages'

const userMessage = (text: string): ThunderboltUIMessage =>
  ({ id: 'u', role: 'user', parts: [{ type: 'text', text }] }) as unknown as ThunderboltUIMessage

const assistantMessage = (text: string): ThunderboltUIMessage =>
  ({ id: 'a', role: 'assistant', parts: [{ type: 'text', text }] }) as unknown as ThunderboltUIMessage

describe('resolveSkillTokenInstructions', () => {
  const map = new Map<string, string>([
    ['meeting-notes', 'You are a meeting-notes summarizer.'],
    ['weekly-review', 'You are a weekly review coach.'],
  ])

  it('returns an empty array when the text has no tokens', () => {
    expect(resolveSkillTokenInstructions('plain message', map)).toEqual([])
  })

  it('returns one instruction per unique resolved skill, in first-seen order', () => {
    expect(resolveSkillTokenInstructions('first /weekly-review then /meeting-notes', map)).toEqual([
      'You are a weekly review coach.',
      'You are a meeting-notes summarizer.',
    ])
  })

  it('dedupes duplicate tokens', () => {
    expect(resolveSkillTokenInstructions('/meeting-notes /meeting-notes again', map)).toEqual([
      'You are a meeting-notes summarizer.',
    ])
  })

  it('skips unknown tokens', () => {
    expect(resolveSkillTokenInstructions('/not-a-real-skill hello', map)).toEqual([])
  })

  it('short-circuits when the map is empty', () => {
    expect(resolveSkillTokenInstructions('/meeting-notes hi', new Map())).toEqual([])
  })

  it('short-circuits when the text is empty', () => {
    expect(resolveSkillTokenInstructions('', map)).toEqual([])
  })
})

describe('extractLastUserText', () => {
  it('returns the empty string when there are no messages', () => {
    expect(extractLastUserText([])).toBe('')
  })

  it('returns the empty string when there are no user messages', () => {
    expect(extractLastUserText([assistantMessage('hi there')])).toBe('')
  })

  it('returns the text of the only user message', () => {
    expect(extractLastUserText([userMessage('hello')])).toBe('hello')
  })

  it('returns the most recent user message text (ignores earlier ones)', () => {
    const messages = [userMessage('old'), assistantMessage('mid'), userMessage('new')]
    expect(extractLastUserText(messages)).toBe('new')
  })

  it('joins multiple text parts of the last user message with newlines', () => {
    const message = {
      id: 'u',
      role: 'user',
      parts: [
        { type: 'text', text: 'first part' },
        { type: 'text', text: 'second part' },
      ],
    } as unknown as ThunderboltUIMessage
    expect(extractLastUserText([message])).toBe('first part\nsecond part')
  })

  it('drops non-text parts before joining', () => {
    const message = {
      id: 'u',
      role: 'user',
      parts: [
        { type: 'text', text: 'before' },
        { type: 'tool-call', toolName: 'something' },
        { type: 'text', text: 'after' },
      ],
    } as unknown as ThunderboltUIMessage
    expect(extractLastUserText([message])).toBe('before\nafter')
  })
})
