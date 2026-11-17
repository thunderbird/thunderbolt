/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test'
import { PageCreateAction } from '@/components/ui/page-create-action'
import { forceMobileViewport, restoreViewport } from '@/test-utils/viewport'
import { createAdminTestHarness } from '../test-utils'
import { AdminPage } from './admin-page'

describe('AdminPage', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)
  afterEach(() => {
    cleanup()
    restoreViewport()
  })

  const renderWithAction = (action = <button type="button">Refresh</button>) =>
    render(
      <AdminPage title="Audit log" action={action}>
        <p>Row</p>
      </AdminPage>,
      { wrapper: createAdminTestHarness().wrapper },
    )

  /** The scrolling list body, which holds the rows. */
  const listBody = () => screen.getByText('Row').parentElement!

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

  it('renders a custom action once, in the header, on desktop', () => {
    renderWithAction()
    const [refresh, ...others] = screen.getAllByRole('button', { name: 'Refresh' })
    expect(others).toHaveLength(0)
    expect(listBody()).not.toContainElement(refresh)
  })

  it('moves a custom action into the list body on phones, where the floating header cannot cover it', () => {
    forceMobileViewport()
    const onClick = mock(() => {})
    renderWithAction(
      <button type="button" onClick={onClick}>
        Refresh
      </button>,
    )
    const [refresh, ...others] = screen.getAllByRole('button', { name: 'Refresh' })
    expect(others).toHaveLength(0)
    expect(listBody()).toContainElement(refresh)
    fireEvent.click(refresh)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('leaves the create pill portaled on phones, with an empty action row', () => {
    forceMobileViewport()
    renderWithAction(<PageCreateAction label="Invite member" onClick={() => {}} />)
    const pill = screen.getByRole('button', { name: 'Invite member' })
    expect(listBody()).not.toContainElement(pill)
    expect(listBody().firstElementChild).toBeEmptyDOMElement()
    expect(listBody().firstElementChild).toHaveClass('empty:hidden')
  })
})
