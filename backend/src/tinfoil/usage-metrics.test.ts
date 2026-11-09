/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { parseTinfoilUsageMetrics } from './usage-metrics'

describe('parseTinfoilUsageMetrics', () => {
  it('reads the counts from a live Tinfoil report and ignores the other fields', () => {
    expect(
      parseTinfoilUsageMetrics(
        'prompt=32,completion=16,total=48,cached_prompt_tokens=0,uncached_prompt_tokens=32,model=deepseek-v4-1-flash,cost_usd=0.0000424',
      ),
    ).toEqual({ promptTokens: 32, completionTokens: 16, totalTokens: 48, cacheReadTokens: 0 })
  })

  it('reads cached prompt tokens as the part of the prompt billed at the cached rate', () => {
    expect(parseTinfoilUsageMetrics('prompt=1000,completion=10,total=1010,cached_prompt_tokens=800')).toEqual({
      promptTokens: 1_000,
      completionTokens: 10,
      totalTokens: 1_010,
      cacheReadTokens: 800,
    })
  })

  it.each([
    ['missing', 'prompt=1000,completion=10,total=1010'],
    ['malformed', 'prompt=1000,completion=10,total=1010,cached_prompt_tokens=x'],
    ['larger than the prompt', 'prompt=1000,completion=10,total=1010,cached_prompt_tokens=1001'],
  ])('charges the whole prompt at the input rate when the cached count is %s', (_, report) => {
    expect(parseTinfoilUsageMetrics(report)).toEqual({ promptTokens: 1_000, completionTokens: 10, totalTokens: 1_010 })
  })

  it('reads keyed fields in any order, including a trailer repeated into one comma-joined value', () => {
    expect(parseTinfoilUsageMetrics('total=10, completion=3,prompt=7, prompt=7,completion=3,total=10')).toEqual({
      promptTokens: 7,
      completionTokens: 3,
      totalTokens: 10,
    })
  })

  it.each([
    ['a missing count', 'prompt=7,completion=3'],
    ['an empty count', 'prompt=7,completion=,total=10'],
    ['a negative count', 'prompt=-7,completion=3,total=10'],
    ['a fractional count', 'prompt=7.5,completion=3,total=10'],
    ['a padded count', 'prompt=07,completion=3,total=10'],
    ['an unsafe integer', 'prompt=9007199254740993,completion=3,total=10'],
    ['an empty report', ''],
  ])('returns null for %s', (_, report) => {
    expect(parseTinfoilUsageMetrics(report)).toBeNull()
  })
})
