/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('bundled provider runtime evaluates the Tinfoil SDK only when selected', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'thunderbolt-tinfoil-isolation-'))
  try {
    const entrypoint = join(directory, 'entry.ts')
    await writeFile(
      entrypoint,
      `import { createTinfoilBinding } from ${JSON.stringify(resolve(import.meta.dir, 'tinfoil.ts'))}
import { defaultModelGlm53 } from ${JSON.stringify(resolve(import.meta.dir, '../../../shared/defaults/models.ts'))}

if (process.argv[2] === 'selected') {
  await createTinfoilBinding({
    credential: {
      type: 'session',
      backendUrl: 'https://api.example.com/v1',
      bearer: 'test-session',
      deviceId: 'cli-test',
      userCacheSecret: new Uint8Array(32).fill(7),
    },
    model: defaultModelGlm53,
    supportsImages: false,
    onStoredSessionRejected: async () => {},
    loadReasoningCapabilities: async () => ({ efforts: [] }),
  })
}
console.log('provider-runtime-loaded')
`,
    )
    const build = await Bun.build({
      entrypoints: [entrypoint],
      outdir: directory,
      target: 'bun',
      minify: true,
      splitting: false,
      plugins: [
        {
          name: 'tinfoil-execution-sentinel',
          setup: (builder) => {
            builder.onResolve({ filter: /^tinfoil$/ }, () => ({ path: 'tinfoil', namespace: 'sentinel' }))
            builder.onLoad({ filter: /.*/, namespace: 'sentinel' }, () => ({
              loader: 'js',
              // A top-level side effect models an SDK compromise, before any constructor runs.
              contents: `console.log('tinfoil-sdk-evaluated'); export class SecureClient {}`,
            }))
          },
        },
      ],
    })
    expect(build.success).toBe(true)

    const run = async (selection: string) => {
      const subprocess = Bun.spawn([process.execPath, join(directory, 'entry.js'), selection], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text(),
        subprocess.exited,
      ])
      expect(stderr).toBe('')
      expect(exitCode).toBe(0)
      return stdout
    }

    expect(await run('unused')).toBe('provider-runtime-loaded\n')
    expect(await run('selected')).toBe('tinfoil-sdk-evaluated\nprovider-runtime-loaded\n')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
