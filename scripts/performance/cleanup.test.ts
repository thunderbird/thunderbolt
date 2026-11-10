/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { collectCleanupErrors, finalizeReport } from './cleanup'

test('failed artifacts cannot skip later browser/profile cleanup or replace the primary error', async () => {
  const steps: string[] = []
  const failures: string[] = []
  const original = new Error('fixture import failed')
  const run = async () => {
    try {
      throw original
    } finally {
      failures.push(
        ...(await collectCleanupErrors([
          {
            name: 'trace',
            run: async () => {
              steps.push('trace')
              throw new Error('disconnected')
            },
          },
          {
            name: 'screenshot',
            run: async () => {
              steps.push('screenshot')
              throw new Error('page closed')
            },
          },
          {
            name: 'browser',
            run: async () => {
              steps.push('browser')
            },
          },
          {
            name: 'profile',
            run: async () => {
              steps.push('profile')
            },
          },
        ])),
      )
    }
  }
  await expect(run()).rejects.toBe(original)
  expect(steps).toEqual(['trace', 'screenshot', 'browser', 'profile'])
  expect(failures).toEqual(['trace: disconnected', 'screenshot: page closed'])
})

test('artifact failures save an incomplete report and fail the run; report-write failure preserves a primary error', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'thunderbolt-report-test-'))
  const report = { completed: true, failure: null as string | null, cleanupErrors: ['screenshot: page closed'] }
  try {
    const path = join(directory, 'report.json')
    await expect(finalizeReport(path, report)).rejects.toThrow('screenshot')
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ ...report, completed: false })
    const original = new Error('scenario failed')
    report.failure = original.message
    const run = async () => {
      try {
        throw original
      } finally {
        await finalizeReport(join(directory, 'missing', 'report.json'), report)
      }
    }
    await expect(run()).rejects.toBe(original)
    expect(report.cleanupErrors.some((error) => error.startsWith('report:'))).toBe(true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
