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
