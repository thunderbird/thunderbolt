/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { csvToTsv, parseCsv, toTsv } from './tabular'

describe('parseCsv', () => {
  test('splits plain fields and rows', () => {
    expect(parseCsv('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  test('keeps commas, line breaks, and escaped quotes inside quoted fields', () => {
    expect(parseCsv('"payee","note"\n"United, Inc","said ""hi""\nthen left"')).toEqual([
      ['payee', 'note'],
      ['United, Inc', 'said "hi"\nthen left'],
    ])
  })

  test('accepts CR-only line endings', () => {
    expect(parseCsv('a,b\r1,2\r')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  test('accepts CRLF line endings and ignores a trailing line break', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  test('strips a leading byte-order mark', () => {
    expect(parseCsv('﻿date,amount\n2026-01-01,5')?.[0]).toEqual(['date', 'amount'])
  })

  test('keeps empty fields, including a trailing one', () => {
    expect(parseCsv('a,,c,\n"",x,,')).toEqual([
      ['a', '', 'c', ''],
      ['', 'x', '', ''],
    ])
  })

  test('returns no rows for empty input', () => {
    expect(parseCsv('')).toEqual([])
  })

  test('allows spaces before an opening quote', () => {
    expect(parseCsv('a, "b, c"')).toEqual([['a', 'b, c']])
  })

  test('opens a quote after any leading whitespace, not only spaces', () => {
    expect(parseCsv('a,\t "b, c"\nd,\u00a0"e"')).toEqual([
      ['a', 'b, c'],
      ['d', 'e'],
    ])
  })

  test('treats a quote after leading whitespace and text as literal', () => {
    expect(parseCsv('a, x"y\nb,  "z"')).toEqual([
      ['a', ' x"y'],
      ['b', 'z'],
    ])
  })

  test('parses a long unquoted field full of quotes in linear time', () => {
    // 320 KB of `a"` took ~1.5s when the opening-quote check re-trimmed the field; now ~6ms.
    const field = 'a"'.repeat(160_000)
    const start = performance.now()
    expect(parseCsv(`h1,h2\nx,${field}`)).toEqual([
      ['h1', 'h2'],
      ['x', field],
    ])
    expect(performance.now() - start).toBeLessThan(500)
  })

  test('keeps a quote inside an unquoted field as a literal character', () => {
    expect(parseCsv('item,qty\n12" pipe,4\nbolt,7')).toEqual([
      ['item', 'qty'],
      ['12" pipe', '4'],
      ['bolt', '7'],
    ])
  })

  test.each([
    ['a quoted field that is never closed', 'a,"open\n1,2\n3,4'],
    ['text after a closing quote', 'a,"open\n1,"b",c'],
  ])('returns null for %s', (_what, text) => {
    expect(parseCsv(text)).toBeNull()
  })
})

describe('toTsv', () => {
  test('joins fields with tabs and ends every row with a line break', () => {
    expect(
      toTsv([
        ['a', 'b'],
        ['1', '2'],
      ]),
    ).toBe('a\tb\n1\t2\n')
  })

  test('replaces tabs and line breaks inside a field with a space', () => {
    expect(toTsv([['one\ttwo', 'line\r\nbreak']])).toBe('one two\tline break\n')
  })

  test('returns empty text for no rows', () => {
    expect(toTsv([])).toBe('')
  })
})

describe('csvToTsv', () => {
  test('round-trips quoted commas into one column each', () => {
    expect(csvToTsv('"payee","amount"\n"Hertz, LLC","-99.5"')).toBe('payee\tamount\nHertz, LLC\t-99.5\n')
  })

  test('keeps blank cells in a single-column file', () => {
    expect(csvToTsv('x\n1\n\n3')).toBe('x\n1\n\n3\n')
  })

  test('drops blank spacer lines in a multi-column file', () => {
    expect(csvToTsv('a,b\n\n1,2\n')).toBe('a\tb\n1\t2\n')
  })

  test.each([
    ['semicolon-delimited with decimal commas', 'a;b\n1,5;2,25'],
    ['tab-delimited', 'a\tb\n1\t2'],
    ['as many semicolons as commas in the header', 'Name;Amount, EUR\nBob;1,5'],
    ['a title line before the header', 'Report Q3\nname;amount\nHertz;1,5'],
    ['pipe-delimited', 'name|amount\nHertz, LLC|1,5'],
    ['malformed quoting', 'a,b\n"open,1\n2,3'],
    ['ragged rows', 'a,b\n1'],
    ['an empty file', ''],
  ])('returns null for %s', (_what, text) => {
    expect(csvToTsv(text)).toBeNull()
  })

  test('ignores delimiters inside quoted header fields', () => {
    expect(csvToTsv('"a;b;c",d\n1,2')).toBe('a;b;c\td\n1\t2\n')
  })
})
