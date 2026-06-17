/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { readJsonFile } from './import-upload'

const fileOf = (name: string, content: string): File => new File([content], name, { type: 'application/json' })

describe('readJsonFile', () => {
  it('parses well-formed JSON', async () => {
    const file = fileOf('export.json', JSON.stringify({ hello: 'world', n: 42 }))
    const parsed = await readJsonFile(file)
    expect(parsed).toEqual({ hello: 'world', n: 42 })
  })

  it('returns arrays and primitives as-is (caller is responsible for envelope checks)', async () => {
    const arr = fileOf('a.json', '[1, 2, 3]')
    await expect(readJsonFile(arr)).resolves.toEqual([1, 2, 3])

    const str = fileOf('s.json', '"hi"')
    await expect(readJsonFile(str)).resolves.toBe('hi')
  })

  it('throws a SyntaxError mentioning the file name on malformed JSON', async () => {
    const file = fileOf('bad.json', '{ not: valid }')
    await expect(readJsonFile(file)).rejects.toBeInstanceOf(SyntaxError)
    await expect(readJsonFile(file)).rejects.toThrow(/bad\.json/)
  })
})
