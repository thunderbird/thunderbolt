/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type Workflow = {
  jobs: Record<string, { if?: string; steps: { name?: string; run?: string; if?: string }[] }>
}

describe('E2E report availability', () => {
  const workflow = Bun.YAML.parse(
    readFileSync(join(import.meta.dir, '../.github/workflows/e2e.yml'), 'utf8'),
  ) as Workflow
  const report = workflow.jobs['e2e-report']

  test('does not start a report job for a cancelled workflow', () => {
    expect(report.if).toContain('!cancelled()')
    for (const name of ['Merge reports', 'Upload HTML report']) {
      expect(report.steps.find((step) => step.name === name)?.if).toBe("steps.blobs.outputs.available == 'true'")
    }
  })

  test.each(['missing', 'empty', 'available'] as const)('handles %s reports', (state) => {
    const directory = mkdtempSync(join(tmpdir(), 'thunderbolt-reports-'))
    try {
      if (state !== 'missing') mkdirSync(join(directory, 'all-blob-reports'))
      if (state === 'available') writeFileSync(join(directory, 'all-blob-reports/report-1.zip'), '')
      const output = join(directory, 'output')
      const summary = join(directory, 'summary')
      writeFileSync(output, '')
      writeFileSync(summary, '')
      const script = report.steps.find((step) => step.name === 'Check for blob reports')!.run!
      const result = spawnSync('bash', ['-e', '-c', script], {
        cwd: directory,
        env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary },
      })
      expect(result.status).toBe(0)
      expect(readFileSync(output, 'utf8')).toBe(state === 'available' ? 'available=true\n' : '')
      expect(readFileSync(summary, 'utf8').includes('No blob reports')).toBe(state !== 'available')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe.each(['postgres', 'frontend', 'marketing'])('%s Alpine security updates', (image) => {
  test.each([1, 3, 4])('succeeds only when the mirror recovers within three attempts (%i)', (succeedAt) => {
    const directory = mkdtempSync(join(tmpdir(), 'thunderbolt-apk-'))
    try {
      writeFileSync(
        join(directory, 'apk'),
        '#!/bin/sh\ncount=$(cat "$ATTEMPTS")\ncount=$((count + 1))\necho "$count" > "$ATTEMPTS"\n[ "$count" -ge "$SUCCEED_AT" ]\n',
      )
      writeFileSync(join(directory, 'sleep'), '#!/bin/sh\nexit 0\n')
      for (const file of ['apk', 'sleep']) chmodSync(join(directory, file), 0o755)
      const attempts = join(directory, 'attempts')
      writeFileSync(attempts, '0')
      const dockerfile = readFileSync(join(import.meta.dir, `../deploy/docker/${image}.Dockerfile`), 'utf8')
      const script = dockerfile.match(/RUN (for attempt[^]*?done)/)![1].replace(/\\\n/g, '')
      const result = spawnSync('sh', ['-e', '-c', script], {
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          ATTEMPTS: attempts,
          SUCCEED_AT: String(succeedAt),
        },
      })
      expect(result.status).toBe(succeedAt <= 3 ? 0 : 1)
      expect(Number(readFileSync(attempts, 'utf8'))).toBe(Math.min(succeedAt, 3))
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
