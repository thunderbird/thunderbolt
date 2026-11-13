/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))

export default defineConfig({
  root,
  publicDir: false,
  build: {
    emptyOutDir: false,
    target: 'es2022',
    outDir: resolve(root, 'ios/Thunderbolt/ChatContent'),
    minify: 'esbuild',
    lib: {
      entry: resolve(root, 'ios/Runtime/artifact-check.ts'),
      name: 'ThunderboltArtifactCheck',
      formats: ['iife'],
      fileName: () => 'artifact-check.js',
    },
    rolldownOptions: { output: { codeSplitting: false } },
  },
})
