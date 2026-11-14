/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { cellCss, hexColor } from './cell-style'
import { rasterType } from './sheet-image'

describe('cellCss', () => {
  it('drops anything in a hostile style that could escape its own CSS value', () => {
    const css = cellCss({
      Font: { Family: 'x"; background:url(https://probe.invalid/font)', Color: 'red;background:url(x)', Size: 400 },
      Fill: { Type: 'pattern', Pattern: 1, Color: ['url(https://probe.invalid/fill)'] },
      Border: [{ Type: 'left', Color: 'expression(alert(1))', Style: 99 }],
    })

    expect(css.fontFamily).toBe('"x backgroundurlhttpsprobeinvalidfont", Carlito, Calibri, Arial, sans-serif')
    expect(css.color).toBeUndefined()
    expect(css.background).toBeUndefined()
    expect(css.borderInlineStart).toBeUndefined()
    expect(css.fontSize).toBe('128px')
    expect(JSON.stringify(css)).not.toMatch(/url\(|expression|;/)
  })

  it('maps fonts, fills, borders and alignment', () => {
    const css = cellCss({
      Font: {
        Bold: true,
        Italic: true,
        Underline: 'single',
        Strike: true,
        Size: 14,
        Family: 'Courier New',
        Color: 'FF00B050',
      },
      Fill: { Type: 'pattern', Pattern: 1, Color: ['DDEBF7'] },
      Border: [
        { Type: 'bottom', Color: '9E9E9E', Style: 6 },
        { Type: 'right', Style: 2 },
      ],
      Alignment: { Horizontal: 'centerContinuous', Vertical: 'top', WrapText: true, Indent: 2 },
    })

    expect(css).toMatchObject({
      fontWeight: 700,
      fontStyle: 'italic',
      textDecoration: 'underline line-through',
      fontSize: `${(14 * 4) / 3}px`,
      fontFamily: '"Courier New", Carlito, Calibri, Arial, sans-serif',
      color: '#00B050',
      background: '#DDEBF7',
      borderBottom: '3px double #9E9E9E',
      borderInlineEnd: '2px solid #000000',
      textAlign: 'center',
      alignItems: 'flex-start',
      whiteSpace: 'pre-wrap',
      paddingInlineStart: 21,
    })
  })

  it('leaves the General alignment and the default font to the cell', () => {
    const css = cellCss({ Font: { Family: 'Calibri', Size: 11 }, Fill: { Type: 'pattern', Pattern: 0 } })

    expect(css.textAlign).toBeUndefined()
    expect(css.fontFamily).toBeUndefined()
    expect(css.fontSize).toBeUndefined()
    expect(css.background).toBeUndefined()
  })

  it('accepts only hex colours', () => {
    expect(hexColor('#1f3864')).toBe('#1f3864')
    expect(hexColor('rgb(0,0,0)')).toBeUndefined()
    expect(hexColor('')).toBeUndefined()
  })
})

describe('rasterType', () => {
  const bytes = (...values: number[]) => new Uint8Array(values)
  const text = (value: string) => new TextEncoder().encode(value)

  it('knows PNG, JPEG, GIF, WebP and BMP by their first bytes', () => {
    expect(rasterType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe('image/png')
    expect(rasterType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg')
    expect(rasterType(text('GIF89a'))).toBe('image/gif')
    expect(rasterType(text('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp')
    expect(rasterType(text('BM\0\0'))).toBe('image/bmp')
  })

  it('refuses SVG and anything else', () => {
    expect(rasterType(text('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeUndefined()
    expect(rasterType(text('<?xml version="1.0"?><svg/>'))).toBeUndefined()
    expect(rasterType(bytes())).toBeUndefined()
  })
})
