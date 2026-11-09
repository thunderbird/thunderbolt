/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from 'bun:test'
import { readFullReport, validateComparison } from './compare'

const report = {
  schemaVersion: 1,
  completed: true,
  browser: '156',
  platform: 'darwin/arm64',
  cpuThrottle: 4,
  diagnosticTrace: false,
  runs: 3,
  samples: [1, 2, 3].map((run) => ({
    run,
    profile: 'mobile' as const,
    name: 'menu',
    taskMs: 20,
    actionMs: 50,
    frameMaxMs: 16.7,
    blockingMs: 0,
    reactCommits: 2,
    heapBytes: 100,
    nodes: 30,
  })),
}

test('compares matching runs but rejects partial, traced and incompatible measurements', () => {
  expect(() => validateComparison(report, report)).not.toThrow()
  expect(() => validateComparison(report, { ...report, completed: false })).toThrow('complete')
  expect(() => validateComparison(report, { ...report, diagnosticTrace: true })).toThrow('diagnostic')
  expect(() => validateComparison(report, { ...report, cpuThrottle: 6 })).toThrow('cpuThrottle')
  expect(() => validateComparison(report, { ...report, browser: '157' })).toThrow('browser')
  expect(() => validateComparison(report, { ...report, samples: [] })).toThrow()
  expect(() => validateComparison(report, { ...report, fixtureVersion: 2 })).toThrow('fixtureVersion')
  expect(() => validateComparison(report, { ...report, measurement: 'paired-targeted-v1' })).toThrow('paired runner')
  expect(() => validateComparison(report, { ...report, measurement: 'startup-v1' })).toThrow('startup samples')
})

test('rejects other report families, malformed measurements and incomplete repetition sets', () => {
  for (const measurement of ['large-session-v1', 'large-session-v2', 'unknown-method']) {
    expect(() => readFullReport({ ...report, measurement })).toThrow('Only full-suite')
  }
  for (const field of ['taskMs', 'actionMs', 'frameMaxMs']) {
    expect(() =>
      readFullReport({ ...report, samples: report.samples.map((sample) => ({ ...sample, [field]: NaN })) }),
    ).toThrow()
  }
  expect(() =>
    readFullReport({ ...report, samples: [report.samples[0], report.samples[0], report.samples[2]] }),
  ).toThrow('Duplicate')
  expect(() => readFullReport({ ...report, samples: report.samples.slice(1) })).toThrow('repetition')
  expect(() => readFullReport({ ...report, runs: undefined })).toThrow()
  expect(() => validateComparison(report, { ...report, schemaVersion: 3 })).toThrow('schemaVersion')
})
