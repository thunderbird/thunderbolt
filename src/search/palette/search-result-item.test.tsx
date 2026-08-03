/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Command, CommandList } from '@/components/ui/command'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'bun:test'
import type { SearchResult } from '../types'
import { SearchResultItem } from './search-result-item'

const result: SearchResult = {
  id: 'thread-1',
  entityType: 'chat',
  title: 'Weekend trip planning',
  snippet: 'Ideas for the trip to the coast',
  to: '/chats/thread-1',
}

const renderRow = (query: string) =>
  render(
    <Command>
      <CommandList>
        <SearchResultItem result={result} query={query} onSelect={() => {}} />
      </CommandList>
    </Command>,
  )

describe('SearchResultItem', () => {
  it('renders the full title and snippet text', () => {
    const { container } = renderRow('trip')
    expect(container.textContent).toContain('Weekend trip planning')
    expect(container.textContent).toContain('Ideas for the trip to the coast')
  })

  it('highlights the matched query token in both title and snippet', () => {
    const { container } = renderRow('trip')
    const highlighted = Array.from(container.querySelectorAll('mark')).map((m) => m.textContent)
    expect(highlighted).toEqual(['trip', 'trip'])
  })
})
