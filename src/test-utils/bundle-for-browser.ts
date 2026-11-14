/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { build, type Rolldown } from 'vite'

/**
 * Bundles one module into a single ES module, as the app's build does, and imports it. Under Bun a dependency
 * resolves to its Node build; the bundle holds its browser build, the one the app ships.
 */
export const bundleForBrowser = async <Module>(entry: string): Promise<Module> => {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      lib: { entry, formats: ['es'] },
      rolldownOptions: { output: { codeSplitting: false } },
    },
  })
  // `write: false` without `watch` resolves to one output.
  const [{ output }] = [result].flat() as Rolldown.RolldownOutput[]
  const dir = mkdtempSync(join(tmpdir(), 'browser-bundle-'))
  try {
    const path = join(dir, `${basename(entry, '.ts')}.mjs`)
    writeFileSync(path, output[0].code)
    return await import(path)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
