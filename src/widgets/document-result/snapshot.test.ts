/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { strToU8, strFromU8, zipSync } from 'fflate'
import { pngHeader } from '@/office/xlsx-preview-test-runtime'
import { fitStyle, pagesZoomToFit, unpackWithinLimits } from './snapshot'

const svg = (inner: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">${inner}</svg>`

const hugePng = btoa(String.fromCharCode(...pngHeader(8192, 8192)))

const unpacked = async (parts: Record<string, string>) => {
  const zip = zipSync(Object.fromEntries(Object.entries(parts).map(([name, text]) => [name, strToU8(text)])))
  const result = await unpackWithinLimits(new Blob([zip]))
  return Object.fromEntries(Object.entries(result).map(([name, data]) => [name, strFromU8(data)]))
}

describe('unpackWithinLimits', () => {
  it.each([
    ['a data: URL', `<image href="data:image/png;base64,${hugePng}"/>`],
    ['a data: URL split by a line break', `<image href="da\nta:image/png;base64,${hugePng}"/>`],
    ['a character reference', `<image href="data&#58;image/png;base64,${hugePng}"/>`],
    ['a CSS escape', `<style>rect { fill: url("d\\61ta:image/png;base64,${hugePng}") }</style>`],
  ])('blanks an SVG that could embed a picture through %s, which no pixel count would see', async (_, inner) => {
    const parts = await unpacked({ 'word/media/image1.svg': svg(inner) })

    expect(parts['word/media/image1.svg']).toBe('<svg xmlns="http://www.w3.org/2000/svg"/>')
  })

  it('blanks such an SVG written in UTF-16', async () => {
    const text = svg(`<image href="data:image/png;base64,${hugePng}"/>`)
    const utf16 = Uint8Array.from([0xff, 0xfe, ...[...text].flatMap((char) => [char.charCodeAt(0), 0])])
    const result = await unpackWithinLimits(new Blob([zipSync({ 'ppt/media/image1.svg': utf16 })]))

    expect(strFromU8(result['ppt/media/image1.svg'])).toBe('<svg xmlns="http://www.w3.org/2000/svg"/>')
  })

  it('keeps a vector SVG, and XML parts that only mention data:', async () => {
    const drawing = svg('<rect width="10" height="10" fill="url(#shade)"/>')
    const body = '<w:document><w:t>Paste a data: URL here</w:t></w:document>'

    expect(await unpacked({ 'word/media/image1.svg': drawing, 'word/document.xml': body })).toEqual({
      'word/media/image1.svg': drawing,
      'word/document.xml': body,
    })
  })
})

describe('fitStyle', () => {
  it('zooms pages to the width of the frame, and never past their own size', () => {
    expect(fitStyle(854)).toBe(
      '<style>html { container-type: inline-size; } body { zoom: min(1, tan(atan2(100cqw, 854px))); }</style>',
    )
  })
})

describe('pagesZoomToFit', () => {
  afterEach(() => {
    mock.restore()
  })

  /** The browser draws the probe's 400px block `width` wide, and its 20px line of text `height` tall. */
  const drawProbe = (width: number, height: number) =>
    spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, width, height))

  it('holds where the zoom draws the block at its container width and the text a quarter of its size', () => {
    drawProbe(100, 5)
    const children = document.body.children.length

    expect(pagesZoomToFit()).toBe(true)
    expect(document.body.children.length).toBe(children)
  })

  it.each([
    ['holds the zoomed text to a minimum size, as Safari does', 100, 9],
    ['computes the zoom wrong or ignores it', 400, 20],
  ])('fails where the browser %s', (_, width, height) => {
    drawProbe(width, height)

    expect(pagesZoomToFit()).toBe(false)
  })
})
