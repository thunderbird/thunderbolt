/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, mock, test } from 'bun:test'
import { compressionThresholdBytes, maybeCompressAttachment, type CompressDeps } from './compress-attachment'

/** Build a File of a given logical size without allocating real bytes. */
const fakeFile = (name: string, type: string, size: number): File => {
  const file = new File(['x'], name, { type })
  Object.defineProperty(file, 'size', { value: size })
  return file
}

const overThreshold = compressionThresholdBytes + 1

const smallerBlob = (size: number, type: string): Blob => new Blob([new Uint8Array(size)], { type })

const deps = (over: Partial<CompressDeps> = {}): CompressDeps => ({
  compressImage: mock(async () => null),
  compressPdf: mock(async () => null),
  ...over,
})

describe('maybeCompressAttachment', () => {
  test('returns files at or below the threshold untouched, without invoking a compressor', async () => {
    const d = deps()
    const file = fakeFile('small.png', 'image/png', compressionThresholdBytes)
    expect(await maybeCompressAttachment(file, d)).toBe(file)
    expect(d.compressImage).not.toHaveBeenCalled()
    expect(d.compressPdf).not.toHaveBeenCalled()
  })

  test('compresses a large image to WebP and renames the extension', async () => {
    const d = deps({ compressImage: mock(async () => smallerBlob(1024, 'image/webp')) })
    const result = await maybeCompressAttachment(fakeFile('Photo.PNG', 'image/png', overThreshold), d)
    expect(d.compressImage).toHaveBeenCalledTimes(1)
    expect(result.type).toBe('image/webp')
    expect(result.name).toBe('Photo.webp')
    expect(result.size).toBe(1024)
  })

  test('compresses a large image identified only by extension (empty/odd MIME)', async () => {
    const d = deps({ compressImage: mock(async () => smallerBlob(1024, 'image/webp')) })
    const result = await maybeCompressAttachment(fakeFile('screenshot.PNG', '', overThreshold), d)
    expect(d.compressImage).toHaveBeenCalledTimes(1)
    expect(result.type).toBe('image/webp')
    expect(result.name).toBe('screenshot.webp')
  })

  test('compresses a large PDF identified only by extension (empty/odd MIME)', async () => {
    const d = deps({ compressPdf: mock(async () => smallerBlob(2048, 'application/pdf')) })
    const result = await maybeCompressAttachment(fakeFile('report.pdf', '', overThreshold), d)
    expect(d.compressPdf).toHaveBeenCalledTimes(1)
    expect(result.type).toBe('application/pdf')
  })

  test('keeps the original image when compression is not smaller', async () => {
    const d = deps({ compressImage: mock(async () => null) })
    const file = fakeFile('photo.jpg', 'image/jpeg', overThreshold)
    expect(await maybeCompressAttachment(file, d)).toBe(file)
  })

  test('skips GIFs to preserve animation', async () => {
    const d = deps()
    const file = fakeFile('loop.gif', 'image/gif', overThreshold)
    expect(await maybeCompressAttachment(file, d)).toBe(file)
    expect(d.compressImage).not.toHaveBeenCalled()
  })

  test('compresses a large PDF, keeping its name and mime', async () => {
    const d = deps({ compressPdf: mock(async () => smallerBlob(2048, 'application/pdf')) })
    const result = await maybeCompressAttachment(fakeFile('report.pdf', 'application/pdf', overThreshold), d)
    expect(d.compressPdf).toHaveBeenCalledTimes(1)
    expect(result.name).toBe('report.pdf')
    expect(result.type).toBe('application/pdf')
    expect(result.size).toBe(2048)
  })

  test('passes non-image/pdf types through even when large', async () => {
    const d = deps()
    const file = fakeFile('data.csv', 'text/csv', overThreshold)
    expect(await maybeCompressAttachment(file, d)).toBe(file)
    expect(d.compressImage).not.toHaveBeenCalled()
    expect(d.compressPdf).not.toHaveBeenCalled()
  })

  test('falls back to the original when a compressor throws', async () => {
    const d = deps({
      compressImage: mock(async () => {
        throw new Error('decode failed')
      }),
    })
    const file = fakeFile('broken.png', 'image/png', overThreshold)
    expect(await maybeCompressAttachment(file, d)).toBe(file)
  })
})
