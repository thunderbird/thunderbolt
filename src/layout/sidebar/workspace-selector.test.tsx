/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useConfigStore } from '@/api/config-store'
import { DatabaseProvider } from '@/contexts'
import { AuthContext } from '@/contexts/auth-context'
import { getDb } from '@/db/database'
import { workspaceMembershipsTable, workspacesTable } from '@/db/tables'
import { SidebarProvider } from '@/components/ui/sidebar'
import { createMockAuthClient } from '@/test-utils/auth-client'
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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { useLocation } from 'react-router'
import { WorkspaceSelector } from './workspace-selector'

const realSession = { user: { id: testUserId, email: 'creator@test.com', name: 'Creator', isAnonymous: false } }

const Wrapper = ({ children }: { children: ReactNode }) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  })
  return (
    <DatabaseProvider db={getDb()}>
      <QueryClientProvider client={queryClient}>
        <AuthContext.Provider value={{ authClient: createMockAuthClient({ session: realSession }) }}>
          <SidebarProvider>{children}</SidebarProvider>
        </AuthContext.Provider>
      </QueryClientProvider>
    </DatabaseProvider>
  )
}

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
  // Reset server policy flags between tests so the footer-gating cases below
  // start from a known "allowed" baseline.
  useConfigStore.getState().updateConfig({})
})

afterEach(() => {
  resetTestTrustDomain()
  useConfigStore.getState().updateConfig({})
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

  it('renders the Create workspace footer button when allowed', async () => {
    renderWithReactivity(<WorkspaceSelector />, {
      route: '/chats/new',
      routePath: '*',
      tables: ['workspaces', 'workspace_memberships'],
      wrapper: Wrapper,
    })

    const trigger = await waitForElement(() => screen.queryByText('Personal'))
    await act(async () => {
      fireEvent.click(trigger)
    })

    await waitForElement(() => screen.queryByRole('button', { name: /create workspace/i }))
    expect(screen.getByRole('button', { name: /create workspace/i })).toBeInTheDocument()
  })

  it('hides the Create workspace button when allowWorkspaceCreationByMembers is false', async () => {
    useConfigStore.getState().updateConfig({ allowWorkspaceCreationByMembers: false })

    renderWithReactivity(<WorkspaceSelector />, {
      route: '/chats/new',
      routePath: '*',
      tables: ['workspaces', 'workspace_memberships'],
      wrapper: Wrapper,
    })

    const trigger = await waitForElement(() => screen.queryByText('Personal'))
    await act(async () => {
      fireEvent.click(trigger)
    })

    expect(screen.queryByRole('button', { name: /create workspace/i })).not.toBeInTheDocument()
  })

  it('clicking Create workspace opens the modal', async () => {
    renderWithReactivity(<WorkspaceSelector />, {
      route: '/chats/new',
      routePath: '*',
      tables: ['workspaces', 'workspace_memberships'],
      wrapper: Wrapper,
    })

    const trigger = await waitForElement(() => screen.queryByText('Personal'))
    await act(async () => {
      fireEvent.click(trigger)
    })

    const createBtn = await waitForElement(() => screen.queryByRole('button', { name: /create workspace/i }))
    await act(async () => {
      fireEvent.click(createBtn)
    })

    expect(screen.getByLabelText('Workspace name')).toBeInTheDocument()
  })
})
