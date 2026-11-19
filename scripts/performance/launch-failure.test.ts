/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

test.each(['run', 'paired'])('%s replaces a previous successful report when Chrome cannot launch', async (runner) => {
  const directory = await mkdtemp(join(tmpdir(), 'thunderbolt-launch-failure-'))
  const reportPath = join(directory, 'launch-failure.json')
  try {
    await writeFile(reportPath, JSON.stringify({ completed: true, stale: true }))
    const result = Bun.spawnSync(
      [
        process.execPath,
        fileURLToPath(new URL(`./${runner}.ts`, import.meta.url)),
        '--out',
        directory,
        '--label',
        'launch-failure',
      ],
      {
        env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: join(directory, 'empty-browser-cache') },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    expect(result.exitCode).not.toBe(0)
    const report = JSON.parse(await readFile(reportPath, 'utf8'))
    expect(report).toMatchObject({ completed: false, browser: '', samples: [], cleanupErrors: [] })
    expect(report).not.toHaveProperty('stale')
    expect(report.failure).toMatch(/executable.*doesn't exist/i)
    expect(result.stderr.toString()).toContain(report.failure)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
