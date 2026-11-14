/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { strFromU8, strToU8, zipSync } from 'fflate'
import JSZip from 'jszip'
import { centralSignature, overlappingStoredEntries, withDeclaredSize, withZip64Count } from '@/test-utils/zip-fixtures'
import { unzipWithinLimits, ZipLimitError } from './unzip-within-limits'

const mib = 1024 * 1024
const limits = { bytes: 32 * mib, parts: 65_535 }

/** The zip with every central directory record saying its part is deflated. */
const allDeflated = (zip: Uint8Array<ArrayBuffer>) => {
  const forged = zip.slice()
  for (let at = Buffer.from(forged).indexOf(centralSignature); at !== -1; ) {
    new DataView(forged.buffer).setUint16(at + 10, 8, true)
    at = Buffer.from(forged).indexOf(centralSignature, at + 4)
  }
  return forged
}

/** A part that deflates to a few kilobytes and unpacks to 64 MiB. */
const spaces = () => new Uint8Array(64 * mib).fill(32)

describe('unzipWithinLimits', () => {
  it('unpacks stored and deflated parts', () => {
    const zip = zipSync({ 'a.xml': [strToU8('<a/>'), { level: 0 }], 'b/c.xml': [strToU8('<c>text</c>'), { level: 9 }] })

    const parts = unzipWithinLimits(zip, limits)

    expect([...parts.keys()]).toEqual(['a.xml', 'b/c.xml'])
    expect(strFromU8(parts.get('b/c.xml')!)).toBe('<c>text</c>')
  })

  it('reads a zip whose sizes follow each part, as streaming writers save it', async () => {
    const zip = await new JSZip()
      .file('ppt/slides/slide1.xml', '<p:sld/>')
      .generateAsync({ type: 'uint8array', compression: 'DEFLATE', streamFiles: true })

    expect(strFromU8(unzipWithinLimits(zip, limits).get('ppt/slides/slide1.xml')!)).toBe('<p:sld/>')
  })

  it('does not inflate a part it is not asked for, however much it holds', () => {
    const zip = withDeclaredSize(zipSync({ 'keep.xml': strToU8('<k/>'), 'media.bin': spaces() }), 'media.bin', 9)

    expect([...unzipWithinLimits(zip, limits, (name) => name.endsWith('.xml')).keys()]).toEqual(['keep.xml'])
  })

  it('stops at the first byte past the size a part declares, before inflating the rest', () => {
    const zip = withDeclaredSize(zipSync({ 'padding.xml': spaces() }), 'padding.xml', 9)

    // fflate's unzipSync would inflate all 64 MiB into a 9-byte buffer and return the 9 bytes.
    expect(() => unzipWithinLimits(zip, limits)).toThrow('unpacks to more than it declares')
  })

  it('refuses a part that unpacks to less than it declares', () => {
    const zip = withDeclaredSize(zipSync({ 'short.xml': strToU8('<s/>') }), 'short.xml', 1000)

    expect(() => unzipWithinLimits(zip, limits)).toThrow('unpacks to less than it declares')
  })

  it('refuses parts that really unpack past the byte limit together', () => {
    const zip = zipSync({ 'a.bin': spaces(), 'b.bin': spaces() })

    expect(() => unzipWithinLimits(zip, limits)).toThrow(new ZipLimitError('bytes'))
  })

  it('counts stored parts that share one payload at their packed size', () => {
    expect(() => unzipWithinLimits(overlappingStoredEntries(40), limits)).toThrow(new ZipLimitError('bytes'))
  })

  it('counts deflated records that share one payload at their packed size, so their input cannot repeat freely', () => {
    // Zeros read as empty stored blocks: a deflate stream that consumes input and produces nothing.
    expect(() => unzipWithinLimits(allDeflated(overlappingStoredEntries(40)), limits)).toThrow(
      new ZipLimitError('bytes'),
    )
  })

  it('refuses more parts than the limit, and a ZIP64 count, before reading any', () => {
    const zip = zipSync({ 'a.xml': strToU8('<a/>'), 'b.xml': strToU8('<b/>') }, { level: 0 })

    expect(() => unzipWithinLimits(zip, { ...limits, parts: 1 })).toThrow(new ZipLimitError('parts'))
    expect(() => unzipWithinLimits(withZip64Count(zip, 70_000), limits)).toThrow(new ZipLimitError('parts'))
  })

  it('refuses a file that is not a zip', () => {
    expect(() => unzipWithinLimits(strToU8('not a zip, just some text'), limits)).toThrow('not a zip')
  })
})
