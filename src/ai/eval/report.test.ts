/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { summarize } from './report'
import type { EvalEngine, EvalResult } from './types'

const result = (engineName: EvalEngine, passed: boolean): EvalResult => ({
  scenario: {
    id: `model/${engineName}/chat/C1`,
    modelName: 'model',
    engineName,
    modeName: 'chat',
    prompt: 'prompt',
    criteria: { mustProduceOutput: true },
  },
  passed,
  failures: passed ? [] : ['failed'],
  responseText: 'response',
  responseLength: 8,
  citations: [],
  widgets: [],
  linkPreviewUrls: [],
  homepageUrls: [],
  reviewSiteUrls: [],
  toolCallCount: 0,
  duplicateToolCallCount: 0,
  retryCount: 0,
  durationMs: 1,
})

describe('summarize', () => {
  test('breaks pass rates down by engine', () => {
    const summary = summarize([result('pi', true), result('pi', false), result('legacy', true)])

    expect(summary.byEngine).toEqual({
      pi: { total: 2, passed: 1, passRate: 50 },
      legacy: { total: 1, passed: 1, passRate: 100 },
    })
  })
})
