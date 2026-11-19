/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, mock } from 'bun:test'
import { getClock } from '@/testing-library'
import { PageSearch } from './page-search'

describe('PageSearch', () => {
  it.each(['clear', 'close'] as const)('does not restore an old query after a quick %s', async (action) => {
    const onSearch = mock((_value: string) => {})
    render(
      <PageSearch onSearch={onSearch}>
        <PageSearch.Button />
        <PageSearch.Input placeholder="Search items" onSearch={onSearch} />
      </PageSearch>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    fireEvent.change(screen.getByPlaceholderText('Search items'), { target: { value: 'stale query' } })
    fireEvent.click(screen.getByRole('button', { name: action === 'clear' ? 'Clear search' : 'Search' }))
    expect(onSearch).toHaveBeenLastCalledWith('')
    await act(async () => {
      await getClock().tickAsync(100)
    })
    expect(onSearch).toHaveBeenLastCalledWith('')
    expect(screen.getByPlaceholderText('Search items')).toHaveValue('')
  })

  it('uses the shared elevated surface for page search inputs', () => {
    render(
      <PageSearch onSearch={() => {}}>
        <PageSearch.Input placeholder="Search items" onSearch={() => {}} />
      </PageSearch>,
    )

    expect(screen.getByPlaceholderText('Search items')).toHaveClass('rounded-xl', 'bg-card')
  })

  it('adds space below the input only while search is open', () => {
    render(
      <PageSearch onSearch={() => {}}>
        <PageSearch.Button />
        <PageSearch.Input placeholder="Search items" onSearch={() => {}} />
      </PageSearch>,
    )

    const wrapper = screen.getByPlaceholderText('Search items').parentElement?.parentElement
    expect(wrapper).toHaveClass('pb-0')
    expect(wrapper).not.toHaveClass('pb-2')
    expect(wrapper).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByPlaceholderText('Search items')).toHaveAttribute('tabindex', '-1')

    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    expect(wrapper).toHaveClass('pb-2')
    expect(wrapper).not.toHaveClass('pb-0')
    expect(wrapper).toHaveAttribute('aria-hidden', 'false')
    expect(screen.getByPlaceholderText('Search items')).not.toHaveAttribute('tabindex')
    expect(screen.getByPlaceholderText('Search items')).toHaveFocus()
  })
})
