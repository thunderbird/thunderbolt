/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { rasterPixels } from './raster-pixels'
import { pngHeader, tinyPng } from './xlsx-preview-test-runtime'

const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0))

const uint16 = (n: number) => [n & 0xff, n >> 8]

/** A GIF's logical screen with no color table, then `blocks`. */
const gif = (width: number, height: number, blocks: number[]) =>
  Uint8Array.from([...ascii('GIF89a'), ...uint16(width), ...uint16(height), 0, 0, 0, ...blocks])

/** An image descriptor: the frame's offset and size, then no local color table. */
const frame = (left: number, top: number, width: number, height: number) => [
  0x2c,
  ...[left, top, width, height].flatMap(uint16),
  0,
]

describe('rasterPixels', () => {
  it('reads the size a PNG claims, without decoding it', () => {
    expect(rasterPixels(tinyPng)).toBe(1)
    expect(rasterPixels(pngHeader(8192, 8192))).toBe(8192 * 8192)
  })

  it('reads a JPEG’s size from its frame header, past the segments before it', () => {
    // SOI, an APP0 segment of 16 bytes, then a baseline frame of 3,000 by 4,000.
    const jpeg = Uint8Array.from([
      0xff,
      0xd8,
      0xff,
      0xe0,
      0,
      16,
      ...Array(14).fill(0),
      0xff,
      0xc0,
      0,
      17,
      8,
      0x0b,
      0xb8,
      0x0f,
      0xa0,
      3,
    ])

    expect(rasterPixels(jpeg)).toBe(3_000 * 4_000)
  })

  it('reads the size of a GIF, a BMP and an extended WebP', () => {
    const plainGif = gif(8192, 4096, frame(0, 0, 8192, 4096))
    const bmp = new Uint8Array(26)
    bmp.set(ascii('BM'))
    new DataView(bmp.buffer).setInt32(18, 640, true)
    // A bottom-up BMP gives its height as a negative number.
    new DataView(bmp.buffer).setInt32(22, -480, true)
    const webp = new Uint8Array(30)
    webp.set([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBPVP8X')])
    webp.set([0xff, 0x1f, 0x00, 0xff, 0x1f, 0x00], 24)

    expect(rasterPixels(plainGif)).toBe(8192 * 4096)
    expect(rasterPixels(bmp)).toBe(640 * 480)
    expect(rasterPixels(webp)).toBe(8192 * 8192)
  })

  it('counts a GIF frame larger than its logical screen, which browsers grow the canvas to', () => {
    expect(rasterPixels(gif(1, 1, frame(0, 0, 16384, 16384)))).toBe(16384 * 16384)
  })

  it('finds a GIF frame past its global color table and extension blocks, its offset counted', () => {
    // A global color table of two colors, a graphic control extension, and a comment in two sub-blocks.
    const bytes = gif(10, 10, [
      ...[0, 0, 0, 255, 255, 255],
      ...[0x21, 0xf9, 4, 0, 0, 0, 0, 0],
      ...[0x21, 0xfe, 2, ...ascii('hi'), 1, 0x21, 0],
      ...frame(5, 5, 10, 10),
    ])
    bytes[10] = 0x80

    expect(rasterPixels(bytes)).toBe(15 * 15)
  })

  it('gives no size for a GIF whose frame is missing or cut short', () => {
    expect(rasterPixels(gif(10, 10, [0x3b]))).toBeUndefined()
    expect(rasterPixels(gif(10, 10, frame(0, 0, 10, 10).slice(0, 7)))).toBeUndefined()
    expect(rasterPixels(gif(10, 10, [0x21, 0xfe, 9, 1, 2]))).toBeUndefined()
  })

  it('gives no size for a header cut short, or for what is no raster image', () => {
    expect(rasterPixels(pngHeader(10, 10).slice(0, 20))).toBeUndefined()
    expect(rasterPixels(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeUndefined()
  })
})
