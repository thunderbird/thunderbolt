/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { copyPowerSyncAssets } from './copy-powersync-assets'

const root = mkdtempSync(path.join(tmpdir(), 'powersync-assets-'))
const workerFile = path.join('worker', 'WASQLiteDB.umd.js')

/** Writes a fake `@powersync/web/dist` whose 1 MB worker is filled with `marker`, so a torn write is visible. */
const writeSource = (dir: string, marker: string) => {
  mkdirSync(path.join(dir, 'worker'), { recursive: true })
  writeFileSync(path.join(dir, workerFile), marker.repeat(1024 * 1024))
  writeFileSync(path.join(dir, 'index.umd.js'), 'same in every version')
  return dir
}

const listFiles = (dir: string) =>
  readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((file) => statSync(path.join(dir, file)).isFile())
    .sort()

/** Classifies a worker file as one complete version, missing, or torn (partially written). */
const classify = (file: string, v1: Buffer, v2: Buffer) => {
  if (!existsSync(file)) {
    return 'missing'
  }
  const content = readFileSync(file)
  if (content.equals(v1)) {
    return 'v1'
  }
  if (content.equals(v2)) {
    return 'v2'
  }
  return 'torn'
}

const childScript = `
import { copyPowerSyncAssets } from ${JSON.stringify(path.join(import.meta.dir, 'copy-powersync-assets.ts'))}
const [, v1, v2, destination, staging, ms] = process.argv
const until = Date.now() + Number(ms)
while (Date.now() < until) {
  copyPowerSyncAssets(v2, destination, staging)
  copyPowerSyncAssets(v1, destination, staging)
}
`

/** Lays out two fake package versions, a destination and a staging dir under `root/<name>`. */
const setup = (name: string) => {
  const dir = path.join(root, name)
  return {
    v1: writeSource(path.join(dir, 'v1'), 'a'),
    v2: writeSource(path.join(dir, 'v2'), 'b'),
    destination: path.join(dir, 'public', '@powersync'),
    staging: path.join(dir, 'cache'),
  }
}

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('copyPowerSyncAssets', () => {
  it('never exposes a missing or torn file while several processes copy at once', async () => {
    const { v1, v2, destination, staging } = setup('race')
    copyPowerSyncAssets(v1, destination, staging)
    const v1Worker = readFileSync(path.join(v1, workerFile))
    const v2Worker = readFileSync(path.join(v2, workerFile))
    const workerState = () => classify(path.join(destination, workerFile), v1Worker, v2Worker)

    // Each child copies for 500 ms, far longer than the spread of their start-up, so they overlap.
    const children = Array.from({ length: 4 }, () =>
      Bun.spawn([process.execPath, '-e', childScript, v1, v2, destination, staging, '500']),
    )
    const seen = new Set<string>()
    while (children.some((child) => child.exitCode === null)) {
      seen.add(workerState())
      await Bun.sleep(0)
    }

    expect(await Promise.all(children.map((child) => child.exited))).toEqual([0, 0, 0, 0])
    expect([...seen].sort()).toEqual(['v1', 'v2'])

    copyPowerSyncAssets(v2, destination, staging)
    expect(workerState()).toBe('v2')
    expect(listFiles(destination)).toEqual(listFiles(v2))
  })

  it('replaces changed files, keeps identical ones and leaves files a new version dropped', () => {
    const { v1, v2, destination, staging } = setup('upgrade')
    writeFileSync(path.join(v1, 'dropped.wasm'), 'only in v1')

    copyPowerSyncAssets(v1, destination, staging)
    const unchangedInode = statSync(path.join(destination, 'index.umd.js')).ino
    copyPowerSyncAssets(v2, destination, staging)

    expect(readFileSync(path.join(destination, workerFile)).equals(readFileSync(path.join(v2, workerFile)))).toBe(true)
    expect(statSync(path.join(destination, 'index.umd.js')).ino).toBe(unchangedInode)
    expect(listFiles(destination)).toEqual([...listFiles(v2), 'dropped.wasm'].sort())
  })
})
