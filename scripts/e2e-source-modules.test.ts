/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { e2eSourceEntries, findE2eSourceModules, isE2eSourceEntry } from './e2e-source-modules'

const root = mkdtempSync(path.join(tmpdir(), 'e2e-source-modules-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const write = (file: string, content = '') => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
  writeFileSync(path.join(root, file), content)
}

write('src/db/database.ts')
write('node_modules/@powersync/web/lib/index.js')
write(
  'e2e/a.spec.ts',
  "await page.evaluate(() => import('/src/db/database.ts'))\nimport('/src/missing.ts')\nimport('/src/db/database.ts')",
)
write('e2e/nested/b.spec.ts', "import('/node_modules/@powersync/web/lib/index.js')")
write('e2e/notes.md', "import('/src/db/database.ts')")

describe('findE2eSourceModules', () => {
  it('lists each existing module URL the specs import, once, skipping missing files and non-TS files', () => {
    expect(findE2eSourceModules(root)).toEqual(['/node_modules/@powersync/web/lib/index.js', '/src/db/database.ts'])
  })
})

describe('e2eSourceEntries', () => {
  it('names each entry under the e2e-source prefix so isE2eSourceEntry recognises it', () => {
    const entries = e2eSourceEntries(root, ['/src/db/database.ts'])
    expect(entries).toEqual({ 'e2e-source/src/db/database.ts': path.join(root, '/src/db/database.ts') })
    expect(Object.keys(entries).every(isE2eSourceEntry)).toBe(true)
    expect(isE2eSourceEntry('app')).toBe(false)
  })
})
