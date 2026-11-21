/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { deflateSync, strFromU8, strToU8, zipSync } from 'fflate'
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

/** A zip with one part, `a.bin`, whose deflate stream is `streams` joined and which declares `declared` bytes. */
const deflatedPart = (declared: number, ...streams: Uint8Array[]) =>
  withDeclaredSize(
    allDeflated(zipSync({ 'a.bin': [new Uint8Array(Buffer.concat(streams)), { level: 0 }] })),
    'a.bin',
    declared,
  )

/** A deflate stored block holding `data`: a header byte, then its length and the length's complement. */
const storedBlock = (data: Uint8Array, final: boolean) => {
  const block = new Uint8Array(5 + data.length)
  const view = new DataView(block.buffer)
  view.setUint8(0, final ? 1 : 0)
  view.setUint16(1, data.length, true)
  view.setUint16(3, ~data.length, true)
  block.set(data, 5)
  return block
}

/** Just over one inflate chunk of empty stored blocks: a stretch of stream that inflates to nothing. */
const emptyBlocks = new Uint8Array(
  Buffer.concat(Array.from({ length: 3300 }, () => storedBlock(new Uint8Array(), false))),
)

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

  it('refuses a part that declares no bytes and unpacks to some', () => {
    expect(() => unzipWithinLimits(deflatedPart(0, deflateSync(strToU8('<a/>'))), limits)).toThrow(
      'unpacks to more than it declares',
    )
    // A part that declares nothing may use only its first chunk of input, and this stream runs past it.
    expect(() =>
      unzipWithinLimits(withDeclaredSize(zipSync({ 'padding.xml': spaces() }), 'padding.xml', 0), limits),
    ).toThrow('unexpected EOF')
  })

  it('refuses output that comes after the declared size is reached', () => {
    const filler = new Uint8Array(16 * 1024 - 5).fill(65)

    // The declared size is reached exactly at the end of the first chunk of input, and the stream goes on.
    expect(() =>
      unzipWithinLimits(deflatedPart(filler.length, storedBlock(filler, false), deflateSync(spaces())), limits),
    ).toThrow('unexpected EOF')
    expect(() =>
      unzipWithinLimits(deflatedPart(filler.length, storedBlock(filler, false), deflateSync(strToU8('<a/>'))), limits),
    ).toThrow('unpacks to more than it declares')
    // A chunk that inflates to nothing after the declared size is still the last one read.
    expect(() =>
      unzipWithinLimits(deflatedPart(1, storedBlock(strToU8('a'), false), emptyBlocks, deflateSync(spaces())), limits),
    ).toThrow('unexpected EOF')
  })

  it('accepts an empty deflated part however it is written', () => {
    const zips = [
      zipSync({ 'a.bin': new Uint8Array() }),
      deflatedPart(0, storedBlock(new Uint8Array(), true)),
      deflatedPart(0),
    ]

    for (const zip of zips) {
      expect(unzipWithinLimits(zip, limits).get('a.bin')).toEqual(new Uint8Array())
    }
  })

  it('stops reading soon after the stream ends, whatever junk follows', () => {
    const zip = deflatedPart(4, deflateSync(strToU8('<a/>')), new Uint8Array(64 * mib))
    const roomy = { ...limits, bytes: 128 * mib }

    expect(strFromU8(unzipWithinLimits(zip, roomy).get('a.bin')!)).toBe('<a/>')
    // Without the stop, each chunk of junk copies all the junk before it: about eight seconds for these 64 MiB.
    expect(() => unzipWithinLimits(withDeclaredSize(zip, 'a.bin', 5), roomy)).toThrow(
      'unpacks to less than it declares',
    )
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
    // Each record holds an empty stream and then zeros, so it inflates without error and only the byte limit stops them.
    const zip = allDeflated(overlappingStoredEntries(40))
    const view = new DataView(zip.buffer)
    zip.set([3, 0], 30 + view.getUint16(26, true) + view.getUint16(28, true))

    expect(() => unzipWithinLimits(zip, limits)).toThrow(new ZipLimitError('bytes'))
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
