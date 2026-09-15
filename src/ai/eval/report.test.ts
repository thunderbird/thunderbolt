/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendTrial, renderMetricsReport, startTrialJournal, writeMarkdownReport, writeMetricsReport } from './report'
import { createManifest, aggregateEvalMetrics, serializeArtifact } from './stats'
import { initLayout, printResult, teardownLayout } from './ui'
import { renderEvalComment } from '../../../.github/scripts/post-eval-results'
import { compareMetricsToBaselines } from './baseline'
import { fixtureManifest, fixtureMetrics, fixtureScenario, fixtureTrial } from './test-fixtures'

const directory = mkdtempSync(join(tmpdir(), 'eval-report-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

test('M2: the actual report shows independent model and engine acceptance rows', () => {
  const pi = fixtureScenario()
  const legacy = { ...pi, id: 'opus/legacy/chat/never', engineName: 'legacy' as const }
  const metrics = aggregateEvalMetrics(fixtureManifest([pi, legacy], 1), [
    fixtureTrial(pi),
    fixtureTrial(legacy, 0, false),
  ])
  const report = renderMetricsReport(metrics)
  expect(report).toContain('| opus/pi | pass |')
  expect(report).toContain('| opus/legacy | exit 1 |')
})

test('JSON metrics retain manifest, every trial, and scored follow-up prompt', () => {
  const scenario = { ...fixtureScenario(), followUps: ['Repeat the price you just found.'] }
  const metrics = aggregateEvalMetrics(fixtureManifest([scenario]), [fixtureTrial(scenario)])
  const path = writeMetricsReport(metrics, join(directory, 'report.md'))
  expect(path).toBe(join(directory, 'eval-metrics.json'))
  const written = JSON.parse(readFileSync(path, 'utf8'))
  expect(written.schemaVersion).toBe(4)
  expect(written.trials).toHaveLength(1)
  expect(written.groups['opus/pi'].scenarios[scenario.id]).toMatchObject({
    n: 3,
    c: 1,
    e: 2,
    prompt: scenario.followUps[0],
  })
})

test('markdown leads with cells and includes category states, SEM, headlines, labels and overdue warnings', () => {
  const metrics = fixtureMetrics(2)
  const path = join(directory, 'report.md')
  writeMarkdownReport(metrics, path, true)
  const markdown = readFileSync(path, 'utf8')
  expect(markdown.indexOf('| Cell |')).toBeLessThan(markdown.indexOf('## Category'))
  for (const text of [
    'exit 1',
    'never_search | fail',
    '66.7%',
    'paraphrase families are correlated',
    'pass^3',
    'flaky (complete)',
    'Unnecessary-search rate',
    'Past-due review dates',
  ]) {
    expect(markdown).toContain(text)
  }
  expect(markdown).not.toContain('Wilson')
})

test('journal persists each completed trial before final metrics exist', () => {
  const manifest = fixtureManifest()
  const path = startTrialJournal(manifest, directory)
  appendTrial(path, fixtureTrial())
  const records = readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(records).toHaveLength(2)
  expect(records[0].manifest).toEqual(manifest)
  expect(records[1].id).toBe(fixtureTrial().id)
})

test('synthetic EVAL_AUTH_TOKEN and credentials never appear in any serialized artifact or report', () => {
  const token = 'synthetic-EVAL_AUTH_TOKEN-marker-932'
  const previous = process.env.EVAL_AUTH_TOKEN
  process.env.EVAL_AUTH_TOKEN = token
  try {
    const metadata = fixtureManifest()
    metadata.preflight = {
      Authorization: `Bearer ${token}`,
      cookie: token,
      nested: { accessToken: token },
      error: `Request used Bearer ${token}`,
    }
    const manifest = createManifest([fixtureScenario()], metadata, {
      EVAL_AUTH_TOKEN: token,
      EVAL_MODELS: 'opus',
      UNLISTED: 'secret',
    })
    expect(manifest.auth).toBe('present')
    expect(manifest.settings).toEqual({ EVAL_MODELS: 'opus' })
    const trial = fixtureTrial()
    trial.attempts[0].instrumentation.preflight = metadata.preflight
    trial.attempts[0].result.responseText = token
    trial.attempts[0].result.failures = [token]
    const metrics = aggregateEvalMetrics(manifest, [trial])
    const journal = startTrialJournal(manifest, directory)
    appendTrial(journal, trial)
    const markdown = join(directory, 'redaction.md')
    writeMarkdownReport(metrics, markdown, true)
    const json = writeMetricsReport(metrics, markdown)
    const artifacts = [
      JSON.stringify(manifest),
      serializeArtifact(trial),
      serializeArtifact(compareMetricsToBaselines(metrics, {})),
      renderMetricsReport(metrics, true),
      ...[journal, markdown, json].map((path) => readFileSync(path, 'utf8')),
    ]
    for (const artifact of artifacts) {
      expect(artifact).not.toContain(token)
    }
    expect(serializeArtifact({ cookie: 'cookie-secret', error: 'cookie-secret' })).not.toContain('cookie-secret')
    const escaped = 'credential-with-"-and-newline\n'
    expect(JSON.parse(serializeArtifact({ token: escaped, echoed: escaped })).echoed).toBe('[REDACTED]')
  } finally {
    if (previous === undefined) {
      delete process.env.EVAL_AUTH_TOKEN
    } else {
      process.env.EVAL_AUTH_TOKEN = previous
    }
  }
})

test('C1: embedded Authorization Cookie and Set-Cookie credentials are redacted at every artifact boundary', () => {
  const markers = [
    'basic-only-secret',
    'digest-only-secret',
    'cookie-only-secret',
    'set-cookie-only-secret',
    'quoted-only-secret',
  ]
  const diagnostic = [
    `request failed; Authorization: Basic ${markers[0]}; Cookie: session=${markers[2]}`,
    `authorization: Digest username="${markers[1]}", response="${markers[1]}"`,
    `Cookie: session=${markers[2]}; second=${markers[2]}`,
    `Set-Cookie: session=${markers[3]}; HttpOnly; Path=/`,
    `headers: {"Authorization":"CustomScheme ${markers[4]}"}`,
  ].join('\n')
  const manifest = fixtureManifest(undefined, 1)
  manifest.preflight = { error: diagnostic }
  const trial = fixtureTrial(undefined, 0, false, 'infra_error')
  trial.attempts[0].error = diagnostic
  trial.attempts[0].result.failures = [diagnostic]
  trial.attempts[0].instrumentation.preflight = { error: diagnostic }
  trial.attempts[0].streams[0].events = [{ type: 'tool-output-error', errorText: diagnostic }]
  const metrics = aggregateEvalMetrics(manifest, [trial])
  const journal = startTrialJournal(manifest, directory)
  appendTrial(journal, trial)
  const markdown = join(directory, 'embedded-headers.md')
  writeMarkdownReport(metrics, markdown, true)
  const json = writeMetricsReport(metrics, markdown)
  const output: string[] = []
  const write = spyOn(process.stdout, 'write').mockImplementation((text) => {
    output.push(String(text))
    return true
  })
  try {
    initLayout([trial.scenario], 1)
    printResult(trial)
    teardownLayout()
  } finally {
    write.mockRestore()
  }
  const artifacts = [
    serializeArtifact({ error: diagnostic }, ['different-EVAL_AUTH_TOKEN']),
    serializeArtifact({ ...compareMetricsToBaselines(metrics, {}), error: diagnostic }),
    renderEvalComment(metrics, {}, { artifactUrl: 'https://example.test/artifacts' }),
    output.join(''),
    ...[journal, markdown, json].map((path) => readFileSync(path, 'utf8')),
  ]
  for (const artifact of artifacts) {
    expect(artifact).toContain('[REDACTED]')
    for (const marker of markers) {
      expect(artifact).not.toContain(marker)
    }
  }
})
