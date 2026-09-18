/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { render } from '@testing-library/react'
import { describe, expect, it } from 'bun:test'
import { HighlightMatch } from './highlight'

const renderHighlight = (text: string, query: string) =>
  render(
    <div data-testid="host">
      <HighlightMatch text={text} query={query} />
    </div>,
  )

const marks = (container: HTMLElement) => Array.from(container.querySelectorAll('mark')).map((m) => m.textContent)

describe('HighlightMatch', () => {
  it('returns the text untouched when the query is empty', () => {
    const { container, getByTestId } = renderHighlight('hello world', '')
    expect(getByTestId('host').textContent).toBe('hello world')
    expect(marks(container)).toEqual([])
  })

  it('returns the text untouched when nothing matches', () => {
    const { container, getByTestId } = renderHighlight('hello world', 'xyz')
    expect(getByTestId('host').textContent).toBe('hello world')
    expect(marks(container)).toEqual([])
  })

  it('wraps a single match', () => {
    const { container } = renderHighlight('hello world', 'world')
    expect(marks(container)).toEqual(['world'])
  })

  it('wraps every occurrence of a token', () => {
    const { container } = renderHighlight('banana', 'a')
    expect(marks(container)).toEqual(['a', 'a', 'a'])
  })

  it('wraps multiple whitespace-separated tokens', () => {
    const { container, getByTestId } = renderHighlight('hello brave new world', 'hello world')
    expect(marks(container)).toEqual(['hello', 'world'])
    expect(getByTestId('host').textContent).toBe('hello brave new world')
  })

  it('matches case-insensitively while preserving original casing', () => {
    const { container } = renderHighlight('Hello World', 'hello')
    expect(marks(container)).toEqual(['Hello'])
  })

  it('treats regex-special characters in the query literally', () => {
    const { container } = renderHighlight('c++ is (great).', 'c++ (great)')
    expect(marks(container)).toEqual(['c++', '(great)'])
  })

  it('does not match the special characters as regex metacharacters', () => {
    const { container } = renderHighlight('abc', '.')
    expect(marks(container)).toEqual([])
  })
})

describe('HighlightMatch folding', () => {
  it('marks accented text for an unaccented query, as the index does', () => {
    const { container, getByTestId } = renderHighlight('weather in São Paulo', 'sao')
    expect(marks(container)).toEqual(['São'])
    expect(getByTestId('host').textContent).toBe('weather in São Paulo')
  })

  it('marks an accented query against unaccented text', () => {
    const { container } = renderHighlight('a trip to Koln', 'köln')
    expect(marks(container)).toEqual(['Koln'])
  })

  it('marks decomposed text without swallowing its combining mark', () => {
    // NFD: 'e' followed by U+0301, so the folded match runs one UTF-16 unit
    // shorter than the original span it has to slice back out.
    const decomposed = 'cafe\u0301 open'
    const { container, getByTestId } = renderHighlight(decomposed, 'cafe')
    expect(marks(container)).toEqual(['cafe\u0301'])
    expect(getByTestId('host').textContent).toBe(decomposed)
  })

  it('marks a substring inside an unsegmented script', () => {
    const { container, getByTestId } = renderHighlight('東京の天気はどうですか', '天気')
    expect(marks(container)).toEqual(['天気'])
    expect(getByTestId('host').textContent).toBe('東京の天気はどうですか')
  })

  it('marks a re-segmented query that has no literal form in the text', () => {
    // `東京天気` matches a row reading `東京の天気` because the planner splits it
    // into 東京 AND 天気. Highlighting has to split it the same way or the row
    // renders with nothing marked.
    const { container, getByTestId } = renderHighlight('東京の天気はどうですか', '東京天気')
    expect(marks(container)).toEqual(['東京', '天気'])
    expect(getByTestId('host').textContent).toBe('東京の天気はどうですか')
  })

  it('does not mark a particle the index never matched on', () => {
    // The planner drops the single-character `の`, so it must not be marked.
    const { container } = renderHighlight('東京の天気はどうですか', '東京の天気')
    expect(marks(container)).toEqual(['東京', '天気'])
  })

  it('merges overlapping token matches instead of nesting them', () => {
    const { container, getByTestId } = renderHighlight('banana', 'ban anan')
    expect(marks(container)).toEqual(['banan'])
    expect(getByTestId('host').textContent).toBe('banana')
  })

  it('keeps surrogate pairs intact around a match', () => {
    const { container, getByTestId } = renderHighlight('🎉 party time', 'party')
    expect(marks(container)).toEqual(['party'])
    expect(getByTestId('host').textContent).toBe('🎉 party time')
  })
})
