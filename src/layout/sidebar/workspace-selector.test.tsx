/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { DatabaseProvider } from '@/contexts'
import { getDb } from '@/db/database'
import { workspaceMembershipsTable, workspacesTable } from '@/db/tables'
import { SidebarProvider } from '@/components/ui/sidebar'
import {
  renderWithReactivity,
  resetTestTrustDomain,
  seedTestTrustDomain,
  waitForElement,
} from '@/test-utils/powersync-reactivity-test'
import {
  otherWsId,
  resetTestDatabase,
  setupTestDatabase,
  teardownTestDatabase,
  testUserId,
  wsId,
} from '@/dal/test-utils'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { useLocation } from 'react-router'
import { WorkspaceSelector } from './workspace-selector'

const Wrapper = ({ children }: { children: ReactNode }) => (
  <DatabaseProvider db={getDb()}>
    <SidebarProvider>{children}</SidebarProvider>
  </DatabaseProvider>
)

/** Renders the current pathname so a test can assert the URL changed. */
const LocationProbe = () => {
  const location = useLocation()
  return <span data-testid={`at-${location.pathname}`}>{location.pathname}</span>
}

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

beforeEach(async () => {
  await resetTestDatabase()
  seedTestTrustDomain()
  const db = getDb()
  await db.insert(workspaceMembershipsTable).values({
    id: `${wsId}-${testUserId}`,
    workspaceId: wsId,
    userId: testUserId,
    role: 'admin',
  })
})

afterEach(() => {
  resetTestTrustDomain()
  cleanup()
})

const seedSharedWorkspace = async () => {
  const db = getDb()
  await db.insert(workspacesTable).values({
    id: otherWsId,
    name: 'Acme',
    isPersonal: 0,
    ownerUserId: testUserId,
  })
  await db.insert(workspaceMembershipsTable).values({
    id: `${otherWsId}-${testUserId}`,
    workspaceId: otherWsId,
    userId: testUserId,
    role: 'admin',
  })
}

describe('WorkspaceSelector', () => {
  it('renders the active workspace name', async () => {
    renderWithReactivity(<WorkspaceSelector />, {
      route: '/chats/new',
      routePath: '*',
      tables: ['workspaces', 'workspace_memberships'],
      wrapper: Wrapper,
    })

    await waitForElement(() => screen.queryByText('Personal'))
    expect(screen.getByText('Personal')).toBeInTheDocument()
  })

  it('switches from personal to shared workspace — adds /w/<id> prefix, preserves sub-path', async () => {
    await seedSharedWorkspace()

    renderWithReactivity(
      <>
        <WorkspaceSelector />
        <LocationProbe />
      </>,
      {
        route: '/settings/preferences',
        routePath: '*',
        tables: ['workspaces', 'workspace_memberships'],
        wrapper: Wrapper,
      },
    )

    // Trigger button shows the active workspace name. Click it to open the dropdown.
    const trigger = await waitForElement(() => screen.queryByText('Personal'))
    await act(async () => {
      fireEvent.click(trigger)
    })

    // Click the Acme item to switch.
    const acmeItem = await waitForElement(() => screen.queryByText('Acme'))
    await act(async () => {
      fireEvent.click(acmeItem)
    })

    await waitForElement(() => screen.queryByTestId(`at-/w/${otherWsId}/settings/preferences`))
    expect(screen.getByTestId(`at-/w/${otherWsId}/settings/preferences`)).toBeInTheDocument()
  })

  it('switches from shared back to personal — strips /w/<id> prefix, preserves sub-path', async () => {
    await seedSharedWorkspace()

    renderWithReactivity(
      <>
        <WorkspaceSelector />
        <LocationProbe />
      </>,
      {
        route: `/w/${otherWsId}/settings/preferences`,
        routePath: '*',
        tables: ['workspaces', 'workspace_memberships'],
        wrapper: Wrapper,
      },
    )

    const trigger = await waitForElement(() => screen.queryByText('Acme'))
    await act(async () => {
      fireEvent.click(trigger)
    })

    // "Personal" appears both as the workspace label and as the inline badge;
    // grab the button that wraps the item rather than the bare text.
    const personalItem = await waitForElement(() =>
      screen.queryByRole('button', { name: (accessibleName) => accessibleName.includes('Personal') }),
    )
    await act(async () => {
      fireEvent.click(personalItem)
    })

    await waitForElement(() => screen.queryByTestId('at-/settings/preferences'))
    expect(screen.getByTestId('at-/settings/preferences')).toBeInTheDocument()
  })
})
