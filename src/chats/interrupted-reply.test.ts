/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, it } from 'bun:test'
import type { ThunderboltUIMessage } from '@/types'
import { getInterruptedReplyId } from './interrupted-reply'

const prompt: ThunderboltUIMessage = { id: 'user', role: 'user', parts: [{ type: 'text', text: 'Build a game' }] }
const reply = (
  parts: ThunderboltUIMessage['parts'],
  metadata?: ThunderboltUIMessage['metadata'],
): ThunderboltUIMessage => ({ id: 'partial', role: 'assistant', parts, metadata })

it.each(['text', 'reasoning'] as const)('detects a saved unfinished %s reply, preserving its content', (type) => {
  const partial = reply([{ type, text: 'Work in progress', state: 'streaming' }], { modelId: 'glm' })
  const messages = [prompt, partial]
  expect(getInterruptedReplyId(messages)).toBe('partial')
  expect(partial.parts[0]).toMatchObject({ state: 'streaming', text: 'Work in progress' })
})

it.each(['completed', 'stopped', 'error'] as const)(
  'respects an authoritative %s outcome even with unfinished SDK parts',
  (turnOutcome) => {
    expect(
      getInterruptedReplyId([
        prompt,
        reply([{ type: 'reasoning', text: 'Done', state: 'streaming' }], { turnOutcome }),
      ]),
    ).toBeUndefined()
  },
)

it('keeps completed reasoning-only turns and old histories without part states untouched', () => {
  for (const state of ['done', undefined] as const) {
    expect(getInterruptedReplyId([prompt, reply([{ type: 'reasoning', text: 'Thought', state }])])).toBeUndefined()
  }
  expect(getInterruptedReplyId([prompt, reply([])])).toBeUndefined()
  expect(getInterruptedReplyId([])).toBeUndefined()
})

it('does not offer interruption recovery for a deliberately stopped prompt or an older reply', () => {
  const partial = reply([{ type: 'reasoning', text: 'Partial', state: 'streaming' }])
  expect(getInterruptedReplyId([{ ...prompt, metadata: { stoppedByUser: true } }, partial])).toBeUndefined()
  expect(getInterruptedReplyId([prompt, partial, { ...prompt, id: 'next-prompt' }])).toBeUndefined()
})

it('distinguishes unfinished tool input from completed and errored tool results', () => {
  expect(
    getInterruptedReplyId([
      prompt,
      reply([
        {
          type: 'dynamic-tool',
          toolName: 'write',
          toolCallId: 'tool',
          state: 'input-available',
          input: { path: 'game.html' },
        },
      ]),
    ]),
  ).toBe('partial')
  for (const part of [
    {
      type: 'dynamic-tool',
      toolName: 'write',
      toolCallId: 'tool',
      state: 'output-available',
      input: {},
      output: 'Written',
    },
    {
      type: 'dynamic-tool',
      toolName: 'write',
      toolCallId: 'tool',
      state: 'output-error',
      input: {},
      errorText: 'Failed',
    },
    {
      type: 'dynamic-tool',
      toolName: 'write',
      toolCallId: 'tool',
      state: 'output-denied',
      input: {},
      approval: { id: 'approval', approved: false, reason: 'Denied' },
    },
  ] satisfies ThunderboltUIMessage['parts']) {
    expect(getInterruptedReplyId([prompt, reply([part])])).toBeUndefined()
  }
})
