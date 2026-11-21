/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Style } from 'excelize-wasm'
import type { CSSProperties } from 'react'

/** Carlito, Calibri's metric-compatible stand-in, comes first, so text still fits its columns without Calibri. */
export const sheetFontStack = 'Carlito, Calibri, Arial, sans-serif'

/** A colour from the file as CSS, only when it is plain hex: `RRGGBB`, or `AARRGGBB` with the alpha dropped. */
export const hexColor = (value: string | undefined) => {
  const match = /^#?(?:[\da-f]{2})?([\da-f]{6})$/i.exec(value ?? '')
  return match ? `#${match[1]}` : undefined
}

/** A font family from the file, reduced to letters, digits, spaces, `_` and `-`, so it cannot end the declaration. */
const fontFamily = (name: string | undefined) => {
  const safe = name
    ?.replace(/[^\p{L}\p{N} _-]/gu, '')
    .trim()
    .slice(0, 64)
  return safe && safe !== 'Calibri' ? `"${safe}", ${sheetFontStack}` : undefined
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/** CSS for Excelize's border styles 1 to 13 (thin, medium, dashed, dotted, thick, double, hair, …), by index. */
const borderLines = [
  undefined,
  '1px solid',
  '2px solid',
  '1px dashed',
  '1px dotted',
  '3px solid',
  '3px double',
  '1px dotted',
  '2px dashed',
  '1px dashed',
  '2px dashed',
  '1px dotted',
  '2px dotted',
  '2px dashed',
] as const

// Keyed by any string, since the file can hold any value.
const borderSides = new Map<string, 'borderInlineStart' | 'borderInlineEnd' | 'borderTop' | 'borderBottom'>([
  ['left', 'borderInlineStart'],
  ['right', 'borderInlineEnd'],
  ['top', 'borderTop'],
  ['bottom', 'borderBottom'],
])

const horizontalAlign = new Map<string, 'left' | 'center' | 'right' | 'justify'>([
  ['left', 'left'],
  ['center', 'center'],
  ['centerContinuous', 'center'],
  ['right', 'right'],
  ['justify', 'justify'],
  ['distributed', 'justify'],
  ['fill', 'left'],
])

const verticalAlign = new Map<string, 'flex-start' | 'center'>([
  ['top', 'flex-start'],
  ['center', 'center'],
  ['justify', 'flex-start'],
  ['distributed', 'flex-start'],
])

const fillOf = ({ Fill: fill }: Style) => {
  const solid = (fill?.Type === 'pattern' && (fill.Pattern ?? 0) > 0) || fill?.Type === 'gradient'
  return solid ? hexColor(fill?.Color?.[0]) : undefined
}

/**
 * A cell style from the file as inline CSS. Every value is rebuilt from checked parts instead of copied: colours must
 * be hex, a font family keeps only safe characters, sizes are clamped and borders come from a fixed list. No `url()`
 * or other declaration can reach the page. `textAlign` is set only when the file sets an alignment, so the cell can
 * fall back to Excel's General alignment.
 */
export const cellCss = (style: Style | undefined): CSSProperties => {
  if (!style) {
    return {}
  }
  const { Font: font, Alignment: alignment } = style
  const decoration = [font?.Underline ? 'underline' : '', font?.Strike ? 'line-through' : ''].filter(Boolean).join(' ')
  const css: CSSProperties = {
    fontWeight: font?.Bold ? 700 : undefined,
    fontStyle: font?.Italic ? 'italic' : undefined,
    textDecoration: decoration || undefined,
    fontSize: font?.Size && font.Size !== 11 ? `${(clamp(font.Size, 4, 96) * 4) / 3}px` : undefined,
    fontFamily: fontFamily(font?.Family),
    color: hexColor(font?.Color),
    background: fillOf(style),
    textAlign: horizontalAlign.get(alignment?.Horizontal ?? ''),
    alignItems: verticalAlign.get(alignment?.Vertical ?? ''),
    whiteSpace: alignment?.WrapText ? 'pre-wrap' : undefined,
    overflowWrap: alignment?.WrapText ? 'anywhere' : undefined,
    paddingInlineStart: alignment?.Indent ? clamp(alignment.Indent, 0, 15) * 9 + 3 : undefined,
  }
  for (const border of style.Border ?? []) {
    const side = borderSides.get(border.Type ?? '')
    const line = borderLines[border.Style ?? 0]
    if (side && line) {
      css[side] = `${line} ${hexColor(border.Color) ?? '#000000'}`
    }
  }
  return css
}
