/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { ImportFormatError } from '@/dal'
import { readJsonFile } from './import-upload'

const fileOf = (name: string, content: string): File => new File([content], name, { type: 'application/json' })

/** Gzip the given JSON string, then wrap it in a `File` so it looks like a real upload. */
const gzipFileOf = async (name: string, content: string): Promise<File> => {
  const stream = new Blob([content]).stream().pipeThrough(new CompressionStream('gzip'))
  const blob = await new Response(stream).blob()
  return new File([blob], name, { type: 'application/gzip' })
}

/** Build a File whose `.size` reports `bytes` without actually allocating that much memory. */
const oversizedFile = (name: string, bytes: number): File => {
  const file = new File(['{}'], name, { type: 'application/json' })
  Object.defineProperty(file, 'size', { value: bytes })
  return file
}

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

  it('transparently decompresses gzipped exports (the canonical .json.gz format)', async () => {
    const payload = { hello: 'world', list: [1, 2, 3], nested: { a: true } }
    const file = await gzipFileOf('export.json.gz', JSON.stringify(payload))
    await expect(readJsonFile(file)).resolves.toEqual(payload)
  })

  it('detects gzip by magic bytes, not by file extension', async () => {
    // Gzipped content with a misleading `.json` filename still decompresses.
    const payload = { kind: 'gzipped-with-json-extension' }
    const gzipped = await gzipFileOf('mislabeled.json', JSON.stringify(payload))
    await expect(readJsonFile(gzipped)).resolves.toEqual(payload)
  })

  it('throws a SyntaxError mentioning the file name on malformed JSON', async () => {
    const file = fileOf('bad.json', '{ not: valid }')
    await expect(readJsonFile(file)).rejects.toBeInstanceOf(SyntaxError)
    await expect(readJsonFile(file)).rejects.toThrow(/bad\.json/)
  })

  it('throws ImportFormatError when a gzipped file is truncated / corrupted', async () => {
    // Cut the gzip stream after the magic bytes — DecompressionStream rejects mid-stream.
    const truncated = new File([new Uint8Array([0x1f, 0x8b, 0x08, 0x00])], 'truncated.json.gz', {
      type: 'application/gzip',
    })
    await expect(readJsonFile(truncated)).rejects.toBeInstanceOf(ImportFormatError)
    await expect(readJsonFile(truncated)).rejects.toThrow(/truncated\.json\.gz/)
  })

  it('rejects oversized files with ImportFormatError before reading them into memory', async () => {
    const file = oversizedFile('huge.json', 300 * 1024 * 1024)
    await expect(readJsonFile(file)).rejects.toBeInstanceOf(ImportFormatError)
    await expect(readJsonFile(file)).rejects.toThrow(/huge\.json/)
    await expect(readJsonFile(file)).rejects.toThrow(/too large/i)
  })
})
