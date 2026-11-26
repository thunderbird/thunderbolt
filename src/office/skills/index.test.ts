/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Glob } from 'bun'
import { expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'

it('leaves the manuals to their own chunks: no app module imports one statically', () => {
  const root = path.join(import.meta.dir, '../../..')
  const manuals = ['docx', 'xlsx', 'pptx'].map((format) => path.join('src/office/skills', format))
  const sources = Array.from(new Glob('src/**/*.{ts,tsx}').scanSync(root)).filter((file) => !/\.test\.tsx?$/.test(file))
  const importers = sources.filter((file) =>
    Array.from(readFileSync(path.join(root, file), 'utf8').matchAll(/\bfrom\s+['"]([^'"]+)['"]/g), ([, spec]) =>
      spec.startsWith('@/') ? path.join('src', spec.slice(2)) : path.join(path.dirname(file), spec),
    ).some((target) => manuals.includes(target)),
  )
  expect(importers).toEqual([])
})
