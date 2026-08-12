/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { summarize, writeMarkdownReport, writeMetricsReport } from './report'
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

describe('necessity reports', () => {
  const outputDirectory = mkdtempSync(join(tmpdir(), 'thunderbolt-eval-'))

  afterAll(() => rmSync(outputDirectory, { recursive: true, force: true }))

  test('writes stable JSON metrics keyed by model and engine', () => {
    const necessityResult: EvalResult = {
      ...result('pi', true),
      scenario: {
        ...result('pi', true).scenario,
        id: 'opus/pi/chat/never-search-01',
        modelName: 'opus',
        prompt: 'Find the current price.',
        followUps: ['Repeat the price you just found.'],
        category: 'never_search',
        reviewBy: '2026-11-04',
      },
      sampleCount: 3,
      passedSampleCount: 2,
      errorSampleCount: 0,
    }
    const markdownPath = join(outputDirectory, 'report.md')

    const coreResult: EvalResult = {
      ...result('pi', false),
      scenario: {
        ...result('pi', false).scenario,
        id: 'opus/pi/chat/C1',
        modelName: 'opus',
      },
    }
    const metricsPath = writeMetricsReport([coreResult, necessityResult], markdownPath, '2026-08-04T12:00:00.000Z')
    const metrics = JSON.parse(readFileSync(metricsPath, 'utf8')) as {
      schemaVersion: number
      groups: Record<string, { scenarios: Record<string, { category: string; prompt: string; sampleCount: number }> }>
    }

    expect(metrics.schemaVersion).toBe(3)
    expect(metrics.groups['opus/pi'].scenarios.C1).toMatchObject({
      category: 'core',
      prompt: 'prompt',
      sampleCount: 1,
    })
    expect(metrics.groups['opus/pi'].scenarios['never-search-01']).toMatchObject({
      prompt: 'Repeat the price you just found.',
      sampleCount: 3,
    })
    expect(metricsPath).toBe(join(outputDirectory, 'eval-metrics.json'))
  })

  test('includes category gates, headlines, and overdue review warnings in markdown', () => {
    const necessityResult: EvalResult = {
      ...result('pi', true),
      scenario: {
        ...result('pi', true).scenario,
        id: 'opus/pi/chat/never-search-01',
        modelName: 'opus',
        category: 'never_search',
        reviewBy: '2026-01-01',
      },
      sampleCount: 3,
      passedSampleCount: 3,
      errorSampleCount: 0,
    }
    const outputPath = join(outputDirectory, 'necessity.md')

    writeMarkdownReport(
      [necessityResult],
      summarize([necessityResult]),
      outputPath,
      false,
      new Date('2026-08-04T12:00:00.000Z'),
    )
    const markdown = readFileSync(outputPath, 'utf8')

    expect(markdown).toContain('## Search Necessity Gate')
    expect(markdown).toContain('| never_search | 1/1 | 100.0%')
    expect(markdown).toContain('Unnecessary-search rate')
    expect(markdown).toContain('Past-due review dates')
    expect(markdown).toContain('opus/pi/chat/never-search-01')
  })
})
