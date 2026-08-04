/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Command, CommandList } from '@/components/ui/command'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, mock } from 'bun:test'
import type { EntityActionType } from '../actions/types'
import type { SearchEntityType, SearchResult } from '../types'
import { SearchResultItem } from './search-result-item'

const chatResult: SearchResult = {
  id: 'thread-1',
  entityType: 'chat',
  title: 'Weekend trip planning',
  snippet: 'Ideas for the trip to the coast',
  to: '/chats/thread-1',
}

const makeResult = (entityType: SearchEntityType): SearchResult => ({
  id: `${entityType}-1`,
  entityType,
  title: `${entityType} title`,
  snippet: '',
  to: `/settings/${entityType}s`,
})

const renderRow = (
  result: SearchResult,
  handlers: {
    query?: string
    onSelect?: (to: string, entityType: SearchEntityType, id: string) => void
    onAction?: (entityType: SearchEntityType, action: EntityActionType, id: string) => void
  } = {},
) =>
  render(
    <Command>
      <CommandList>
        <SearchResultItem
          result={result}
          query={handlers.query ?? ''}
          onSelect={handlers.onSelect ?? (() => {})}
          onAction={handlers.onAction ?? (() => {})}
        />
      </CommandList>
    </Command>,
  )

describe('SearchResultItem', () => {
  it('renders the full title and snippet text', () => {
    const { container } = renderRow(chatResult, { query: 'trip' })
    expect(container.textContent).toContain('Weekend trip planning')
    expect(container.textContent).toContain('Ideas for the trip to the coast')
  })

  it('promotes the snippet to the primary line for a titleless (message) result without duplicating it', () => {
    const messageResult: SearchResult = {
      id: 'msg-1',
      entityType: 'message',
      title: '',
      snippet: 'the only line for a message',
      to: '/chats/thread-1',
    }
    const { container } = renderRow(messageResult, { query: 'line' })
    const occurrences = (container.textContent ?? '').split('the only line for a message').length - 1
    expect(occurrences).toBe(1)
  })

  it('highlights the matched query token in both title and snippet', () => {
    const { container } = renderRow(chatResult, { query: 'trip' })
    const highlighted = Array.from(container.querySelectorAll('mark')).map((m) => m.textContent)
    expect(highlighted).toEqual(['trip', 'trip'])
  })

  it('renders edit and remove buttons for entities that support them (model, skill)', () => {
    for (const entityType of ['model', 'skill'] as const) {
      const { unmount } = renderRow(makeResult(entityType))
      expect(screen.getByRole('button', { name: /Edit/ })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /Remove/ })).toBeInTheDocument()
      unmount()
    }
  })

  it('renders no action buttons for entities without inline actions', () => {
    for (const entityType of ['chat', 'message', 'device', 'task'] as const) {
      const { unmount } = renderRow(makeResult(entityType))
      expect(screen.queryByRole('button', { name: /Edit/ })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /Remove/ })).not.toBeInTheDocument()
      unmount()
    }
  })

  it('forwards to, entityType, and id to onSelect when the row is selected', () => {
    const onSelect = mock(() => {})
    renderRow(chatResult, { onSelect })

    fireEvent.click(screen.getByRole('option', { name: /Weekend trip planning/ }))

    expect(onSelect).toHaveBeenCalledWith('/chats/thread-1', 'chat', 'thread-1')
  })

  it('fires onAction (not the row onSelect) when an action button is clicked', () => {
    const onSelect = mock(() => {})
    const onAction = mock(() => {})
    renderRow(makeResult('model'), { onSelect, onAction })

    fireEvent.click(screen.getByRole('button', { name: /Edit/ }))

    expect(onAction).toHaveBeenCalledWith('model', 'edit', 'model-1')
    expect(onSelect).not.toHaveBeenCalled()
  })
})
