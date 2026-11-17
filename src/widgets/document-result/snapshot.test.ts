/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { strToU8, strFromU8, zipSync } from 'fflate'
import { pngHeader } from '@/office/xlsx-preview-test-runtime'
import { unpackWithinLimits } from './snapshot'

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
