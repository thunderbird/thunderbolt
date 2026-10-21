/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { LanguageModelUsage, ModelMessage } from 'ai'
import { describe, expect, it } from 'bun:test'
import { getAbortedRunCounts, getSettledRunCounts } from './usage-estimate'

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
const missingUsage: LanguageModelUsage = { ...reportedUsage, inputTokens: undefined }

describe('getAbortedRunCounts', () => {
  it('estimates at three characters a token, with no cache tokens', () => {
    const { counts, estimated } = getAbortedRunCounts({ system: 'x'.repeat(10), messages, outputText: 'Hello' })
    expect(estimated).toBe(true)
    expect(counts).toEqual({
      promptTokens: 4 + serializedMessagesTokens,
      completionTokens: 2,
      totalTokens: 6 + serializedMessagesTokens,
      cacheCreationTokens: 0,
      cacheCreation1hTokens: 0,
      cacheReadTokens: 0,
    })
  })

  it('counts the tool definitions a step that offers tools is sent', () => {
    const withoutTools = getAbortedRunCounts({ system: '', messages, outputText: '' }).counts.promptTokens
    const withTools = getAbortedRunCounts({ system: '', toolDefinitions: 'd'.repeat(300), messages, outputText: '' })
    expect(withTools.counts.promptTokens).toBe(withoutTools + 100)
  })

  it('counts each Chinese, Japanese or Korean character as a token', () => {
    const japanese = '今日はとても良い天気ですね散歩に行きましょうか駅まで歩いて行'
    expect([...japanese]).toHaveLength(30)
    const { counts } = getAbortedRunCounts({ system: japanese, messages: [], outputText: japanese })
    expect(counts.completionTokens).toBe(30)
    // The system prompt's 30, plus one for the empty message list's `[]`.
    expect(counts.promptTokens).toBe(31)
  })

  it('counts the rest of a mixed string at three characters a token', () => {
    const { counts } = getAbortedRunCounts({ system: '', messages: [], outputText: 'Tokyo は東京、 ok' })
    // は東京 are three tokens; "Tokyo ", "、 ok" are 10 characters, so four.
    expect(counts.completionTokens).toBe(7)
  })

  it('counts Hangul and characters outside the Basic Multilingual Plane as one token each', () => {
    const { counts } = getAbortedRunCounts({ system: '', messages, outputText: '안녕하세요𠮷' })
    expect(counts.completionTokens).toBe(6)
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

  it('bills the finished steps of a tool-calling run at their usage, plus an estimate for the step in flight', () => {
    const { counts, estimated } = getAbortedRunCounts({
      finishedSteps: [reportedUsage, reportedUsage],
      system: 'x'.repeat(10),
      messages,
      outputText: 'Hello',
    })
    expect(estimated).toBe(true)
    expect(counts).toEqual({
      promptTokens: 240 + 4 + serializedMessagesTokens,
      completionTokens: 14 + 2,
      totalTokens: 254 + 6 + serializedMessagesTokens,
      cacheCreationTokens: 0,
      cacheCreation1hTokens: 0,
      cacheReadTokens: 40,
    })
  })

  it('leaves out a finished step the provider reported no usage for', () => {
    const { counts } = getAbortedRunCounts({
      finishedSteps: [missingUsage, reportedUsage],
      system: '',
      messages,
      outputText: '',
    })
    expect(counts.promptTokens).toBe(120 + serializedMessagesTokens)
    expect(counts.completionTokens).toBe(7)
  })

  it('estimates when onFinish ran without the provider usage', () => {
    expect(getAbortedRunCounts({ reportedUsage: missingUsage, system: '', messages, outputText: '' }).estimated).toBe(
      true,
    )
  })
  it("bills the run's total once when it arrived, without adding the finished steps it already covers", () => {
    expect(
      getAbortedRunCounts({ reportedUsage, finishedSteps: [reportedUsage], system: 'x', messages, outputText: 'Hi' }),
    ).toEqual({
      counts: { promptTokens: 120, completionTokens: 7, totalTokens: 127, cacheCreationTokens: 0, cacheReadTokens: 20 },
      estimated: false,
    })
  })
})

describe('getSettledRunCounts', () => {
  it('bills a finished run at its reported total', () => {
    expect(getSettledRunCounts(reportedUsage, [reportedUsage, reportedUsage])).toEqual({
      promptTokens: 120,
      completionTokens: 7,
      totalTokens: 127,
      cacheCreationTokens: 0,
      cacheReadTokens: 20,
    })
  })

  it('bills a run whose later step failed at what its finished steps reported', () => {
    expect(getSettledRunCounts(missingUsage, [reportedUsage, missingUsage, reportedUsage])).toEqual({
      promptTokens: 240,
      completionTokens: 14,
      totalTokens: 254,
      cacheCreationTokens: 0,
      cacheCreation1hTokens: 0,
      cacheReadTokens: 40,
    })
  })

  it('has nothing to bill when no step reported usage', () => {
    expect(getSettledRunCounts(missingUsage, [missingUsage])).toBeNull()
  })
})
