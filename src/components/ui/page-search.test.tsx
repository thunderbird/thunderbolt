/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'bun:test'
import { PageSearch } from './page-search'

describe('PageSearch', () => {
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

    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    expect(wrapper).toHaveClass('pb-2')
    expect(wrapper).not.toHaveClass('pb-0')
  })
})
