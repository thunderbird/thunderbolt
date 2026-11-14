/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { lastValue, readAttributes, visitStartTags, type XmlAttribute } from './xlsx-drawings'

describe('readAttributes', () => {
  it('reads each attribute in order, in either quote style, its prefix apart and its value decoded', () => {
    expect(readAttributes(` r="B2" x:s='1' t="&#88;&amp;"/`)).toEqual([
      { prefix: '', local: 'r', value: 'B2' },
      { prefix: 'x', local: 's', value: '1' },
      { prefix: '', local: 't', value: 'X&' },
    ])
  })

  it('splits a name as Go does: a Unicode prefix apart, a name with two colons or an edge colon all local', () => {
    expect(readAttributes(` é:r="1" a:b:c="2" :d="3"`).map(({ prefix, local }) => [prefix, local])).toEqual([
      ['é', 'r'],
      ['', 'a:b:c'],
      ['', ':d'],
    ])
  })

  it('keeps a name written inside another value as that value, and every repeat in order', () => {
    const attributes = readAttributes(` note=' r="A1"' r="A1" r="T9"`)

    expect(attributes.map(({ local }) => local)).toEqual(['note', 'r', 'r'])
    expect(lastValue(attributes, 'r')).toBe('T9')
  })

  it('reads an attribute after megabytes of whitespace, where a pattern gives up in JavaScriptCore', () => {
    expect(lastValue(readAttributes(` r="T1"${' '.repeat(2_097_152)}`), 'r')).toBe('T1')
  })
})

describe('visitStartTags', () => {
  const tagsOf = (xml: string, names: string[]) => {
    const tags: [string, XmlAttribute[]][] = []
    visitStartTags(xml, new Set(names), (local, attributes) => {
      tags.push([local, attributes])
      return true
    })
    return tags.map(([local, attributes]) => `${local}${attributes.map(({ value }) => ` ${value}`).join('')}`)
  }

  it('finds start tags by local name, any prefix, a quoted > inside one included', () => {
    expect(tagsOf(`<é:row r="1"><x:c note="?>" r="A1"/><cell r="Z9"/></é:row><row/>`, ['row', 'c'])).toEqual([
      'row 1',
      'c ?> A1',
      'row',
    ])
  })

  it('goes on from a < that breaks off a tag, and stops where the visit says', () => {
    const seen: string[] = []
    visitStartTags('<c r="A1" <c r="B1"><c r="C1">', new Set(['c']), (_, attributes) => {
      seen.push(lastValue(attributes, 'r') ?? '')
      return false
    })

    expect(seen).toEqual(['B1'])
  })
})
