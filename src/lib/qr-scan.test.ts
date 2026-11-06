/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * qr-scan tests. The real decode path (`createImageBitmap` + canvas + jsQR) is
 * unavailable/unbounded under the test DOM, so those three are stubbed. The
 * load-bearing assertion is the decompression-bomb guard: `decodeQrFromFile`
 * must hand `createImageBitmap` a resize bound on BOTH edges, so the decode can
 * never allocate the source's full (attacker-declared) resolution.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

/** Mirror of `qr-scan.ts`'s internal caps (kept in sync deliberately). */
const maxScanEdge = 2048
const maxImageBytes = 15 * 1024 * 1024

type FakeQr = { data: string } | null
const jsQRMock = mock(
  (_data: Uint8ClampedArray, _width: number, _height: number): FakeQr => ({
    data: 'decoded-payload',
  }),
)
mock.module('jsqr', () => ({ default: jsQRMock }))

import { decodeQrFromFile } from './qr-scan'

type BitmapOptions = { resizeWidth?: number; resizeHeight?: number; resizeQuality?: string }

let createImageBitmapCalls = 0
let lastBitmapOptions: BitmapOptions | undefined
const originalCreateImageBitmap = globalThis.createImageBitmap
const originalCreateElement = document.createElement

const fakeCanvas = (): HTMLCanvasElement =>
  ({
    width: 0,
    height: 0,
    getContext: () => ({
      drawImage: () => {},
      getImageData: (_x: number, _y: number, w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4),
        width: w,
        height: h,
      }),
    }),
  }) as unknown as HTMLCanvasElement

beforeEach(() => {
  createImageBitmapCalls = 0
  lastBitmapOptions = undefined
  globalThis.createImageBitmap = (async (_source: unknown, options?: BitmapOptions) => {
    createImageBitmapCalls += 1
    lastBitmapOptions = options
    return { width: options?.resizeWidth ?? 8, height: options?.resizeHeight ?? 8, close: () => {} }
  }) as unknown as typeof globalThis.createImageBitmap
  document.createElement = ((tag: string) =>
    tag === 'canvas' ? fakeCanvas() : originalCreateElement.call(document, tag)) as typeof document.createElement
})

afterEach(() => {
  globalThis.createImageBitmap = originalCreateImageBitmap
  document.createElement = originalCreateElement
  jsQRMock.mockClear()
  jsQRMock.mockImplementation(
    (_data: Uint8ClampedArray, _width: number, _height: number): FakeQr => ({
      data: 'decoded-payload',
    }),
  )
})

const imageFile = (bytes = 8): File => new File([new Uint8Array(bytes)], 'qr.png', { type: 'image/png' })

describe('decodeQrFromFile', () => {
  it('bounds the createImageBitmap decode to maxScanEdge on each edge', async () => {
    const result = await decodeQrFromFile(imageFile())
    expect(result).toBe('decoded-payload')
    expect(createImageBitmapCalls).toBe(1)
    // The decode is bounded on BOTH axes — a tiny file that declares a huge raster
    // can never allocate beyond maxScanEdge².
    expect(lastBitmapOptions?.resizeWidth).toBeGreaterThan(0)
    expect(lastBitmapOptions?.resizeHeight).toBeGreaterThan(0)
    expect(lastBitmapOptions?.resizeWidth).toBeLessThanOrEqual(maxScanEdge)
    expect(lastBitmapOptions?.resizeHeight).toBeLessThanOrEqual(maxScanEdge)
  })

  it('rejects an oversized file before attempting any decode', async () => {
    const big = new File([new Uint8Array(maxImageBytes + 1)], 'big.png', { type: 'image/png' })
    await expect(decodeQrFromFile(big)).rejects.toThrow(/too large/i)
    expect(createImageBitmapCalls).toBe(0)
  })

  it('rejects a non-image file before attempting any decode', async () => {
    const txt = new File(['hello'], 'note.txt', { type: 'text/plain' })
    await expect(decodeQrFromFile(txt)).rejects.toThrow(/not an image/i)
    expect(createImageBitmapCalls).toBe(0)
  })

  it('throws when no QR code is detected', async () => {
    jsQRMock.mockImplementation(() => null)
    await expect(decodeQrFromFile(imageFile())).rejects.toThrow(/no qr code/i)
  })
})
