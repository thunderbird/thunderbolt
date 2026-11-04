/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { cloudModelSchema } from './validation'

const custom = {
  provider: 'openai-compatible',
  modelId: 'custom',
  connectionId: 'model',
  contextWindow: 128000,
  maxOutputTokens: 8192,
  inputCostPerMillion: 1,
  outputCostPerMillion: 3,
}

describe('cloud model budget configuration', () => {
  it('requires real prices for custom model runs', () => {
    expect(cloudModelSchema.safeParse(custom).success).toBe(true)
    expect(cloudModelSchema.safeParse({ ...custom, inputCostPerMillion: undefined }).success).toBe(false)
    expect(cloudModelSchema.safeParse({ ...custom, outputCostPerMillion: 0 }).success).toBe(false)
    expect(cloudModelSchema.safeParse({ ...custom, outputCostPerMillion: -1 }).success).toBe(false)
  })
  it('rejects output limits that consume the entire context or noninteger limits', () => {
    expect(cloudModelSchema.safeParse({ ...custom, maxOutputTokens: 128000 }).success).toBe(false)
    expect(cloudModelSchema.safeParse({ ...custom, maxOutputTokens: 1.5 }).success).toBe(false)
    expect(cloudModelSchema.safeParse({ ...custom, contextWindow: 16 }).success).toBe(false)
  })
})
