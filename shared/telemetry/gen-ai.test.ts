/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { genAiAttributeAllowlist, redactGenAiSpan } from './gen-ai'

const contentKeys = [
  'gen_ai.input.messages',
  'gen_ai.output.messages',
  'gen_ai.system_instructions',
  'gen_ai.tool.definitions',
  'gen_ai.tool.call.arguments',
  'gen_ai.tool.call.result',
]

describe('GenAI span redaction', () => {
  it('never allowlists a content attribute', () => {
    expect(contentKeys.filter((key) => genAiAttributeAllowlist.has(key))).toEqual([])
  })

  it('strips every content attribute and swaps the resource', () => {
    const span = {
      attributes: { 'gen_ai.operation.name': 'chat', ...Object.fromEntries(contentKeys.map((key) => [key, 'secret'])) },
      resource: 'detected',
    }

    const redacted = redactGenAiSpan(span, 'minimal')

    expect(redacted?.attributes).toEqual({ 'gen_ai.operation.name': 'chat' })
    expect(redacted?.resource).toBe('minimal')
  })

  it('drops spans without gen_ai.operation.name', () => {
    expect(redactGenAiSpan({ attributes: { 'http.url': 'x' }, resource: 'detected' }, 'minimal')).toBeUndefined()
  })
})
