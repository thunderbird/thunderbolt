/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test'
import { createAdminTestHarness } from '../test-utils'
import { AdminPage } from './admin-page'

describe('AdminPage', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)
  afterEach(() => {
    cleanup()
  })

  it('renders the title, actions and rows', () => {
    render(
      <AdminPage title="Members" action={<button type="button">Invite</button>}>
        <p>Row</p>
      </AdminPage>,
      { wrapper: createAdminTestHarness().wrapper },
    )
    expect(screen.getByRole('heading', { name: 'Members' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Invite' })).toBeInTheDocument()
    expect(screen.getByText('Row')).toBeInTheDocument()
  })

  it('searches through the header search box', () => {
    const onSearch = mock((_value: string) => {})
    render(<AdminPage title="Members" search={{ label: 'Search members', placeholder: 'Name', onSearch }} />, {
      wrapper: createAdminTestHarness().wrapper,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search members' }), { target: { value: 'ada' } })
    expect(onSearch).toHaveBeenCalledWith('ada')
  })

  it('shows the detail panel', () => {
    render(<AdminPage title="Members" panel={<p>Details</p>} onClose={() => {}} />, {
      wrapper: createAdminTestHarness().wrapper,
    })
    expect(screen.getByText('Details')).toBeInTheDocument()
  })
})
