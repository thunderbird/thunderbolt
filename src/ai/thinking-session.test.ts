/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import {
  isThinkingDisabledForSend,
  openaiCompatThinkingProviderOptions,
  withThinkingDisabledForSend,
} from './thinking-session'

describe('isThinkingDisabledForSend', () => {
  it('is true only for thinking-capable models with the chip off', () => {
    expect(isThinkingDisabledForSend({ startWithReasoning: 1 }, false)).toBe(true)
    expect(isThinkingDisabledForSend({ startWithReasoning: 1 }, true)).toBe(false)
    expect(isThinkingDisabledForSend({ startWithReasoning: 1 }, undefined)).toBe(false)
    expect(isThinkingDisabledForSend({ startWithReasoning: 0 }, false)).toBe(false)
  })
})

describe('withThinkingDisabledForSend', () => {
  it('returns the same model reference when thinking stays on', () => {
    const model = { startWithReasoning: 1 as const, name: 'qwen' }
    expect(withThinkingDisabledForSend(model, true)).toBe(model)
    expect(withThinkingDisabledForSend(model, undefined)).toBe(model)
  })

  it('returns a copy with startWithReasoning cleared when the chip is off', () => {
    const model = { startWithReasoning: 1, name: 'qwen' }
    const next = withThinkingDisabledForSend(model, false)
    expect(next).not.toBe(model)
    expect(next).toEqual({ startWithReasoning: 0, name: 'qwen' })
    expect(model.startWithReasoning).toBe(1)
  })
})

describe('openaiCompatThinkingProviderOptions', () => {
  it('requests reasoningEffort none when the chip disabled thinking', () => {
    expect(openaiCompatThinkingProviderOptions(true)).toEqual({ reasoningEffort: 'none' })
  })

  it('adds no provider options when thinking stays on', () => {
    expect(openaiCompatThinkingProviderOptions(false)).toEqual({})
  })
})
