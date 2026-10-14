/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import {
  isBlankTextPart,
  isHostedAgentPartType,
  startOnUserMessage,
  startsAndEndsOnUserMessage,
} from './hosted-agent-history'

describe('hosted agent history rules', () => {
  it('replays text from both roles and files from neither', () => {
    expect(isHostedAgentPartType('user', 'text')).toBe(true)
    expect(isHostedAgentPartType('user', 'file')).toBe(false)
    expect(isHostedAgentPartType('assistant', 'text')).toBe(true)
    expect(isHostedAgentPartType('assistant', 'file')).toBe(false)
    expect(isHostedAgentPartType('system', 'text')).toBe(false)
    expect(isHostedAgentPartType('user', 'data-attachment')).toBe(false)
  })

  it('treats only whitespace text as blank', () => {
    expect(isBlankTextPart({ type: 'text', text: ' \n ' })).toBe(true)
    expect(isBlankTextPart({ type: 'text', text: 'hi' })).toBe(false)
    expect(isBlankTextPart({ type: 'file' })).toBe(false)
  })

  it('requires a history to start and end with a user message', () => {
    expect(startsAndEndsOnUserMessage([{ role: 'user' }, { role: 'assistant' }, { role: 'user' }])).toBe(true)
    expect(startsAndEndsOnUserMessage([{ role: 'assistant' }, { role: 'user' }])).toBe(false)
    expect(startsAndEndsOnUserMessage([{ role: 'user' }, { role: 'assistant' }])).toBe(false)
    expect(startsAndEndsOnUserMessage([])).toBe(false)
  })

  it('drops leading messages up to the first user message, or everything when there is none', () => {
    expect(startOnUserMessage([{ role: 'assistant' }, { role: 'user' }]).map((m) => m.role)).toEqual(['user'])
    expect(startOnUserMessage([{ role: 'assistant' }])).toEqual([])
  })
})
