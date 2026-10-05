/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveAgentSystemPrompt } from './prompt'

describe('resolveAgentSystemPrompt', () => {
  it('returns an inline prompt as-is', async () => {
    expect(await resolveAgentSystemPrompt('You are helpful.')).toBe('You are helpful.')
  })

  it('reads a file: prompt from disk', async () => {
    const path = join(tmpdir(), `agent-prompt-${crypto.randomUUID()}.md`)
    await Bun.write(path, 'Line one\nLine two\n')
    expect(await resolveAgentSystemPrompt(`file:${path}`)).toBe('Line one\nLine two\n')
  })

  it('fails loudly when the prompt file is missing', async () => {
    expect(resolveAgentSystemPrompt('file:/nonexistent/agent-prompt.md')).rejects.toThrow()
  })
})
