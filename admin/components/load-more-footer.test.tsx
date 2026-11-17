/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { LoadMoreFooter } from './load-more-footer'

describe('LoadMoreFooter', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders nothing after the last page', () => {
    const { container } = render(<LoadMoreFooter hasMore={false} isLoading={false} onLoadMore={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('loads the next page', () => {
    const onLoadMore = mock(() => {})
    render(<LoadMoreFooter hasMore isLoading={false} onLoadMore={onLoadMore} />)
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    expect(onLoadMore).toHaveBeenCalledTimes(1)
  })

  it('is disabled while a page loads', () => {
    render(<LoadMoreFooter hasMore isLoading onLoadMore={() => {}} />)
    expect(screen.getByRole('button', { name: 'Load more' })).toBeDisabled()
  })
})
