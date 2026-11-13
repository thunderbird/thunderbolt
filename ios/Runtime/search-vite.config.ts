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
  resolve: { alias: { '@': resolve(root, 'src') } },
  build: {
    emptyOutDir: false,
    target: 'es2022',
    outDir: resolve(root, 'ios/Thunderbolt/Library'),
    lib: { entry: resolve(root, 'ios/Runtime/search-plan.ts'), name: 'ThunderboltSearchPlan', formats: ['iife'], fileName: () => 'search-plan.js' },
    rolldownOptions: { output: { codeSplitting: false } },
  },
})
