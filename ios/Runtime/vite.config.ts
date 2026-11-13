/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lingui } from '@lingui/vite-plugin'
import { defineConfig } from 'vite'

const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))

export default defineConfig({
  root: repositoryRoot,
  publicDir: false,
  plugins: [lingui({ failOnCompileError: true })],
  resolve: {
    conditions: ['browser'],
    alias: {
      module: resolve(repositoryRoot, 'shared/agent-core/browser-stubs/node-module.ts'),
      'node:module': resolve(repositoryRoot, 'shared/agent-core/browser-stubs/node-module.ts'),
      path: 'path-browserify',
      'node:path': 'path-browserify',
      'fs/promises': resolve(repositoryRoot, 'shared/agent-core/browser-stubs/node-fs-promises.ts'),
      'node:fs/promises': resolve(repositoryRoot, 'shared/agent-core/browser-stubs/node-fs-promises.ts'),
      fs: resolve(repositoryRoot, 'shared/agent-core/browser-stubs/node-fs.cjs'),
      'node:fs': resolve(repositoryRoot, 'shared/agent-core/browser-stubs/node-fs.cjs'),
      crypto: resolve(repositoryRoot, 'shared/agent-core/browser-stubs/node-crypto.ts'),
      'node:crypto': resolve(repositoryRoot, 'shared/agent-core/browser-stubs/node-crypto.ts'),
      '@': resolve(repositoryRoot, 'src'),
      '@shared': resolve(repositoryRoot, 'shared'),
    },
  },
  build: {
    emptyOutDir: false,
    target: 'es2022',
    outDir: resolve(repositoryRoot, 'ios/Thunderbolt/AgentRuntime'),
    minify: false,
    lib: {
      entry: resolve(repositoryRoot, 'ios/Runtime/entry.ts'),
      name: 'ThunderboltPiRuntimeBundle',
      formats: ['iife'],
      fileName: () => 'agent-runtime.js',
    },
    rolldownOptions: { output: { codeSplitting: false } },
  },
})
