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

  type Browser = { appliesZoom: boolean; minimumTextPx: number }

  /**
   * The zoom of an element and its ancestors, as a browser computes it: the fit zoom resolves `100cqw` against the
   * nearest ancestor with `container-type: inline-size`, and with no such ancestor, or any other zoom, it is 1.
   */
  const zoomOf = (element: HTMLElement | null, browser: Browser): number => {
    if (!element) {
      return 1
    }
    const width = /^min\(1, tan\(atan2\(100cqw, (\d+)px\)\)\)$/.exec(element.style.zoom)?.[1]
    const container = element.parentElement?.closest<HTMLElement>('[style*="container-type: inline-size"]')
    const own = browser.appliesZoom && width && container ? Math.min(1, parseFloat(container.style.width) / +width) : 1
    return own * zoomOf(element.parentElement, browser)
  }

  /**
   * Draws whatever the probe mounts, so the probe must hold its own CSS: an element's width and its text's font size
   * and line height, times the zoom of the element and its ancestors. Text is never drawn below `minimumTextPx`.
   */
  const layOut = (browser: Browser) =>
    spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const zoom = zoomOf(this, browser)
      const fontSize = parseFloat(this.style.fontSize)
      const text = fontSize ? Math.max(fontSize * zoom, browser.minimumTextPx) : 0
      return new DOMRect(
        0,
        0,
        (parseFloat(this.style.width) || 0) * zoom,
        text * (Number(this.style.lineHeight) || 1.2),
      )
    })

  it('holds where the zoom draws the block at its container width and the text a quarter of its size', () => {
    layOut({ appliesZoom: true, minimumTextPx: 0 })
    const children = document.body.children.length

    expect(pagesZoomToFit()).toBe(true)
    expect(document.body.children.length).toBe(children)
  })

  it.each([
    ['holds the zoomed text to a minimum size, as Safari does', { appliesZoom: true, minimumTextPx: 9 }],
    ['ignores the zoom', { appliesZoom: false, minimumTextPx: 0 }],
  ])('fails where the browser %s', (_, browser) => {
    layOut(browser)

    expect(pagesZoomToFit()).toBe(false)
  })
})
