/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'
import { confidentialSdkIsolationErrors, confidentialSdkIsolationPlugin } from './confidential-sdk-isolation'

type Chunk = Parameters<typeof confidentialSdkIsolationErrors>[0][number]
type Module = Parameters<typeof confidentialSdkIsolationErrors>[1][number]

const entry = '/app/src/index.ts'
const route = '/app/src/settings/index.ts'
const tinfoilAdapter = '/app/src/attestation/tinfoil.ts'
const privatemodeAdapter = '/app/src/attestation/privatemode.ts'
const tinfoilSdk = '/app/node_modules/tinfoil/index.js'
const privatemodeSdk = '/app/node_modules/privatemode-ai/index.js'
const crypto = '/app/node_modules/attestation-crypto/index.js'
const shared = '/app/node_modules/shared/index.js'

/** Describe input dependencies separately from the bundler's emitted chunks. */
const module = (id: string, imports: string[] = []): Module => ({ id, imports, isEntry: id === entry })

/** Create the minimum output metadata needed to check actual bundle reachability. */
const chunk = (fileName: string, moduleIds: string[], extra: Partial<Chunk> = {}): Chunk => ({
  fileName,
  moduleIds,
  isEntry: fileName === 'entry.js',
  facadeModuleId: moduleIds[0],
  imports: [],
  dynamicImports: [],
  ...extra,
})

const modules = [
  module(entry, [route, tinfoilAdapter, privatemodeAdapter, shared]),
  module(route, [shared]),
  module(tinfoilAdapter, [tinfoilSdk]),
  module(privatemodeAdapter, [privatemodeSdk]),
  module(tinfoilSdk, [crypto, shared]),
  module(privatemodeSdk, [crypto, shared]),
  module(crypto),
  module(shared),
]
const chunks = [
  chunk('entry.js', [entry, shared], { dynamicImports: ['settings.js', 'tinfoil.js', 'privatemode.js'] }),
  chunk('settings.js', [route], { imports: ['entry.js'] }),
  chunk('tinfoil.js', [tinfoilAdapter, tinfoilSdk], { imports: ['crypto.js', 'entry.js'] }),
  chunk('privatemode.js', [privatemodeAdapter, privatemodeSdk], { imports: ['crypto.js', 'entry.js'] }),
  chunk('crypto.js', [crypto]),
]

it('allows independent lazy SDKs, their private shared crypto chunk, and application dependencies', () => {
  expect(confidentialSdkIsolationErrors(chunks, modules)).toEqual([])
})

it('rejects an SDK statically imported by the app or a warmed lazy route', () => {
  for (const fileName of ['entry.js', 'settings.js']) {
    const unsafe = chunks.map((output) =>
      output.fileName === fileName ? { ...output, imports: [...output.imports, 'tinfoil.js'] } : output,
    )
    expect(confidentialSdkIsolationErrors(unsafe, modules).join('\n')).toContain('Application loads tinfoil')
  }
})

it('rejects SDK code hoisted into a common vendor chunk', () => {
  const unsafe = chunks.map((output) =>
    output.fileName === 'entry.js' ? { ...output, moduleIds: [...output.moduleIds, tinfoilSdk] } : output,
  )
  expect(confidentialSdkIsolationErrors(unsafe, modules).join('\n')).toContain('Application loads tinfoil')
})

it('also rejects SDK-exclusive transitive code hoisted into the app', () => {
  const unsafe = chunks.map((output) =>
    output.fileName === 'entry.js' ? { ...output, imports: ['crypto.js'] } : output,
  )
  expect(confidentialSdkIsolationErrors(unsafe, modules).join('\n')).toContain('attestation-crypto')
})

it('rejects one provider loading the other SDK', () => {
  const unsafe = chunks.map((output) =>
    output.fileName === 'tinfoil.js' ? { ...output, imports: [...output.imports, 'privatemode.js'] } : output,
  )
  expect(confidentialSdkIsolationErrors(unsafe, modules).join('\n')).toContain('tinfoil loads privatemode-ai')
})

it('follows non-adapter dynamic imports too', () => {
  const unsafe = chunks.map((output) =>
    output.fileName === 'settings.js' ? { ...output, dynamicImports: ['crypto.js'] } : output,
  )
  expect(confidentialSdkIsolationErrors(unsafe, modules).join('\n')).toContain('settings.js -> crypto.js')
})

it('rejects externalized SDK imports outside an adapter', () => {
  const unsafe = [chunk('entry.js', [entry], { imports: ['privatemode-ai'] })]
  expect(confidentialSdkIsolationErrors(unsafe, [module(entry)]).join('\n')).toContain(
    'Application loads privatemode-ai',
  )
})

it('recognizes nested SDK copies and Windows paths', () => {
  const unsafe = [chunk('entry.js', [entry, 'C:\\app\\node_modules\\.bun\\tinfoil@2\\node_modules\\tinfoil\\index.js'])]
  expect(confidentialSdkIsolationErrors(unsafe, [module(entry)]).join('\n')).toContain('Application loads tinfoil')
})

it.each(['tinfoil', 'privatemode'] as const)(
  'does not execute either SDK on entry/route imports and loads only %s when selected',
  async (selected) => {
    const directory = mkdtempSync(path.join(tmpdir(), 'confidential-sdk-isolation-'))
    const tracker = `sdkIsolation${path.basename(directory).replaceAll('-', '')}`
    const runtime = globalThis as typeof globalThis & Record<string, unknown>
    const evaluations: string[] = []
    runtime[tracker] = evaluations
    const files: Record<string, string> = {
      [entry]: `
      export const openSettings = () => import('${route}');
      export const useTinfoil = () => import('${tinfoilAdapter}');
      export const usePrivatemode = () => import('${privatemodeAdapter}');
    `,
      [route]: 'export const label = "Settings";',
      [tinfoilAdapter]: `export { request } from '${tinfoilSdk}';`,
      [privatemodeAdapter]: `export { request } from '${privatemodeSdk}';`,
      [tinfoilSdk]: `globalThis['${tracker}'].push('tinfoil'); export const request = () => 'tinfoil';`,
      [privatemodeSdk]: `globalThis['${tracker}'].push('privatemode'); export const request = () => 'privatemode';`,
    }
    try {
      await build({
        configFile: false,
        root: directory,
        logLevel: 'silent',
        plugins: [
          {
            name: 'sdk-isolation-fixture',
            resolveId: (id) => (id in files ? id : undefined),
            load: (id) => files[id],
          },
          confidentialSdkIsolationPlugin(),
        ],
        build: {
          outDir: directory,
          emptyOutDir: false,
          modulePreload: false,
          minify: false,
          rolldownOptions: {
            input: entry,
            preserveEntrySignatures: 'strict',
            output: { entryFileNames: 'entry.js' },
          },
        },
      })
      const application = (await import(pathToFileURL(path.join(directory, 'entry.js')).href)) as {
        openSettings: () => Promise<unknown>
        useTinfoil: () => Promise<{ request: () => string }>
        usePrivatemode: () => Promise<{ request: () => string }>
      }
      await application.openSettings()
      expect(evaluations).toEqual([])
      const useSelected = selected === 'tinfoil' ? application.useTinfoil : application.usePrivatemode
      const useOther = selected === 'tinfoil' ? application.usePrivatemode : application.useTinfoil
      expect((await useSelected()).request()).toBe(selected)
      expect(evaluations).toEqual([selected])
      await useOther()
      expect(evaluations).toEqual([selected, selected === 'tinfoil' ? 'privatemode' : 'tinfoil'])
    } finally {
      delete runtime[tracker]
      rmSync(directory, { recursive: true, force: true })
    }
  },
)
