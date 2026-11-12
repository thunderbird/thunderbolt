/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from 'bun:test'
import { readFileSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dir, '../..')
const buildStage = readFileSync(join(import.meta.dir, 'frontend.Dockerfile'), 'utf8')
  .split(/^FROM /m)[1]!
  .replace(/\\\r?\n/g, ' ')
const copies = [...buildStage.matchAll(/^COPY (.+)$/gm)].flatMap(([, instruction]) => {
  const parts = instruction!.trim().split(/\s+/)
  const destination = parts.pop()!
  return parts.map((source) => ({ source, destination }))
})

/** Match the path inside /app, including transitive imports copied as part of a directory. */
const isCopiedAtBuildPath = (file: string): boolean =>
  copies.some(({ source, destination }) => {
    const sourcePath = join(root, source)
    if (!statSync(sourcePath).isDirectory()) {
      return sourcePath === file && join(destination, basename(source)) === relative(root, file)
    }
    const child = relative(sourcePath, file)
    return !child.startsWith('..') && !isAbsolute(child) && join(destination, child) === relative(root, file)
  })

test('the frontend image includes every HTML build entry', () => {
  const config = readFileSync(join(root, 'vite.config.ts'), 'utf8')
  const entries = [...config.matchAll(/path\.resolve\(dirname, '([^']+\.html)'\)/g)].map((match) => match[1]!)
  expect(entries.length).toBeGreaterThan(0)
  for (const entry of entries) {
    expect(isCopiedAtBuildPath(join(root, entry))).toBe(true)
  }
})

test('the frontend image copies the complete local Vite configuration import graph', async () => {
  const loaded: string[] = []
  const result = await Bun.build({
    entrypoints: [join(root, 'vite.config.ts')],
    target: 'bun',
    packages: 'external',
    plugins: [
      {
        name: 'check-container-inputs',
        setup(build) {
          build.onLoad({ filter: /.*/ }, ({ path }) => {
            loaded.push(path)
            if (!isCopiedAtBuildPath(path)) {
              throw new Error(`Frontend image is missing Vite build dependency: ${relative(root, path)}`)
            }
          })
        },
      },
    ],
  })
  expect(result.logs).toEqual([])
  expect(result.success).toBe(true)
  expect(loaded.length).toBeGreaterThan(1)
})
