/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import '@testing-library/jest-dom'
import { cleanup, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { Route, Routes, useLocation } from 'react-router'
import AdminRoutes from './admin-routes'
import { adminNavGroups } from './admin-sidebar'
import { createAdminTestHarness, type FakeRequest } from './test-utils'

const screens = [
  ['/admin/members', 'Members'],
  ['/admin/groups', 'Groups'],
  ['/admin/sign-in-methods', 'Sign-in methods'],
  ['/admin/link-reviews', 'Link reviews'],
  ['/admin/audit-log', 'Audit log'],
]

const CurrentPath = () => <output aria-label="path">{useLocation().pathname}</output>

// Reads that aren't cursor pages, or page under another name; every other list answers `{ items }`.
const emptyReads: Record<string, unknown> = {
  'admin/link-reviews': { reviews: [], nextCursor: null },
  'admin/audit-events': { events: [], nextCursor: null },
  'admin/break-glass': { allAdminsIdpManaged: false, adminCount: 1, localAdminCount: 1 },
}

const emptyBackend = ({ path }: FakeRequest) => ({ body: emptyReads[path] ?? { items: [], nextCursor: null } })

const renderAt = (path: string) => {
  const { wrapper: Wrapper } = createAdminTestHarness(emptyBackend, { initialEntries: [path] })
  return render(
    <Wrapper>
      <Routes>
        <Route path="/admin/*" element={<AdminRoutes />} />
      </Routes>
      <CurrentPath />
    </Wrapper>,
  )
}

describe('AdminRoutes', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)
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
