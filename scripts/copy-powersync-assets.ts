/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Copies the `@powersync/web` browser assets into `destination`, safe for concurrent callers that share
 * one `node_modules`. Nothing is deleted and identical files are skipped. A changed file is staged in
 * `stagingDir` (same disk, outside `public/`) and renamed over the old one, so readers never see it torn.
 *
 * shortcut: files a newer @powersync/web no longer ships stay behind, so a stale copy can hide a renamed
 * worker in local dev; delete public/@powersync after an upgrade that renames or drops files.
 */
export const copyPowerSyncAssets = (source: string, destination: string, stagingDir: string) => {
  const staged = path.join(stagingDir, `powersync-asset-${process.pid}.tmp`)
  mkdirSync(stagingDir, { recursive: true })
  for (const file of readdirSync(source, { recursive: true, encoding: 'utf8' })) {
    const from = path.join(source, file)
    if (!statSync(from).isFile()) {
      continue
    }
    const to = path.join(destination, file)
    const content = readFileSync(from)
    if (existsSync(to) && readFileSync(to).equals(content)) {
      continue
    }
    mkdirSync(path.dirname(to), { recursive: true })
    writeFileSync(staged, content)
    renameSync(staged, to)
  }
}
