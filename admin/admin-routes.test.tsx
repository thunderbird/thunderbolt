/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import '@testing-library/jest-dom'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import AdminRoutes from './admin-routes'
import { adminNavGroups } from './admin-sidebar'

const screens = [
  ['/admin/members', 'Members'],
  ['/admin/groups', 'Groups'],
  ['/admin/invitations', 'Invitations'],
  ['/admin/identity-providers', 'Identity providers'],
  ['/admin/domains', 'Domains'],
  ['/admin/link-reviews', 'Link reviews'],
  ['/admin/audit-log', 'Audit log'],
  ['/admin/break-glass', 'Break-glass'],
]

const CurrentPath = () => <output aria-label="path">{useLocation().pathname}</output>

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/admin/*" element={<AdminRoutes />} />
      </Routes>
      <CurrentPath />
    </MemoryRouter>,
  )

describe('AdminRoutes', () => {
  afterEach(() => {
    cleanup()
  })

  it('has a route for every sidebar entry', () => {
    expect(adminNavGroups.flatMap((group) => group.items.map((item) => item.path))).toEqual(
      screens.map(([path]) => path),
    )
  })

  it.each(screens)('renders %s as "%s"', (path, title) => {
    renderAt(path)
    expect(screen.getByRole('heading', { name: title })).toBeInTheDocument()
  })

  it('opens on members', () => {
    renderAt('/admin')
    expect(screen.getByLabelText('path')).toHaveTextContent('/admin/members')
  })

  it('sends an unknown path to members', () => {
    renderAt('/admin/nowhere')
    expect(screen.getByLabelText('path')).toHaveTextContent('/admin/members')
  })
})
