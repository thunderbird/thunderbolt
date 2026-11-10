/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

let bundle: Promise<string> | undefined

/** Exercise the production host channel in real engines without starting an app or backend server. */
export const installArtifactChannel = async (page: Page) => {
  bundle ??= (async () => {
    const result = await build({
      configFile: false,
      logLevel: 'silent',
      resolve: { alias: { '@shared': fileURLToPath(new URL('../shared', import.meta.url)) } },
      build: {
        write: false,
        minify: false,
        lib: {
          entry: fileURLToPath(new URL('../src/artifacts/channel.ts', import.meta.url)),
          name: 'artifactChannel',
          formats: ['iife'],
        },
      },
    })
    const output = Array.isArray(result) ? result[0] : result
    if (!('output' in output) || output.output[0].type !== 'chunk') {
      throw new Error('Artifact channel fixture did not produce a browser script')
    }
    return output.output[0].code
  })()
  await page.addScriptTag({ content: await bundle })
}
