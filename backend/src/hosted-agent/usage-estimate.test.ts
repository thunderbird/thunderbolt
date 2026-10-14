/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { LanguageModelUsage, ModelMessage } from 'ai'
import { describe, expect, it } from 'bun:test'
import { getAbortedRunCounts } from './usage-estimate'

const messages: ModelMessage[] = [{ role: 'user', content: 'Hi' }]
// `[{"role":"user","content":"Hi"}]` is 32 characters.
const serializedMessagesTokens = Math.ceil(32 / 3)

const reportedUsage: LanguageModelUsage = {
  inputTokens: 120,
  inputTokenDetails: { noCacheTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 0 },
  outputTokens: 7,
  outputTokenDetails: { textTokens: 7, reasoningTokens: undefined },
  totalTokens: 127,
}

describe('getAbortedRunCounts', () => {
  it('estimates at three characters a token, with no cache tokens', () => {
    const { counts, estimated } = getAbortedRunCounts({ system: 'x'.repeat(10), messages, outputText: 'Hello' })
    expect(estimated).toBe(true)
    expect(counts).toEqual({
      promptTokens: 4 + serializedMessagesTokens,
      completionTokens: 2,
      totalTokens: 6 + serializedMessagesTokens,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    })
  })

  it('estimates no output tokens for a run that streamed nothing', () => {
    const { counts } = getAbortedRunCounts({ system: '', messages, outputText: '' })
    expect(counts.completionTokens).toBe(0)
    expect(counts.promptTokens).toBe(serializedMessagesTokens)
  })

  it('bills the provider usage instead of an estimate when it arrived before the abort', () => {
    expect(getAbortedRunCounts({ reportedUsage, system: 'x', messages, outputText: 'Hello' })).toEqual({
      counts: { promptTokens: 120, completionTokens: 7, totalTokens: 127, cacheCreationTokens: 0, cacheReadTokens: 20 },
      estimated: false,
    })
  })

  it('estimates when onFinish ran without the provider usage', () => {
    const missingUsage = { ...reportedUsage, inputTokens: undefined }
    expect(getAbortedRunCounts({ reportedUsage: missingUsage, system: '', messages, outputText: '' }).estimated).toBe(
      true,
    )
  })
})
