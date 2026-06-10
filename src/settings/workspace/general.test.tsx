/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AuthProvider, DatabaseProvider, HttpClientProvider } from '@/contexts'
import {
  otherWsId,
  resetTestDatabase,
  setupTestDatabase,
  teardownTestDatabase,
  testUserId,
  wsId,
} from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { workspaceMembershipsTable, workspacesTable } from '@/db/tables'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createMockHttpClient } from '@/test-utils/http-client'
import {
  renderWithReactivity,
  resetTestTrustDomain,
  seedTestTrustDomain,
  waitForElement,
} from '@/test-utils/powersync-reactivity-test'
import { getClock } from '@/testing-library'
import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import type { ReactNode } from 'react'
import WorkspaceGeneralPage from './general'

const pageAuthClient = createMockAuthClient({
  session: { user: { id: testUserId, email: 'a@b.com', name: 'Alice', isAnonymous: false } },
})
const pageHttpClient = createMockHttpClient()

const DbWrapper = ({ children }: { children: ReactNode }) => (
  <DatabaseProvider db={getDb()}>
    <HttpClientProvider httpClient={pageHttpClient}>
      <AuthProvider authClient={pageAuthClient}>{children}</AuthProvider>
    </HttpClientProvider>
  </DatabaseProvider>
)

const seedSharedWorkspaceWithMembership = async (role: 'admin' | 'member', name = 'Acme') => {
  const db = getDb()
  await db.insert(workspacesTable).values({
    id: otherWsId,
    name,
    isPersonal: 0,
    ownerUserId: null,
  })
  await db.insert(workspaceMembershipsTable).values({
    id: `${otherWsId}-${testUserId}`,
    workspaceId: otherWsId,
    userId: testUserId,
    role,
  })
}

/** Advance the fake clock past the autosave debounce + flush microtasks. */
const flushAutosave = async () => {
  await act(async () => {
    await getClock().tickAsync(700)
    await getClock().runAllAsync()
  })
}

describe('WorkspaceGeneralPage', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    await resetTestDatabase()
    seedTestTrustDomain()
  })

  afterEach(() => {
    resetTestTrustDomain()
    cleanup()
  })

  it('renders the workspace name and enables editing for a shared workspace', async () => {
    await seedSharedWorkspaceWithMembership('admin', 'Acme')

    renderWithReactivity(<WorkspaceGeneralPage />, {
      route: `/w/${otherWsId}/settings/workspace/general`,
      routePath: '/*',
      tables: ['workspaces'],
      wrapper: DbWrapper,
    })

    const input = (await waitForElement(() =>
      (screen.getByLabelText('Workspace name') as HTMLInputElement).value === 'Acme'
        ? screen.getByLabelText('Workspace name')
        : null,
    )) as HTMLInputElement
    expect(input.disabled).toBe(false)
  })

  it('autosaves a renamed shared workspace after the debounce window', async () => {
    await seedSharedWorkspaceWithMembership('admin', 'Old')

    renderWithReactivity(<WorkspaceGeneralPage />, {
      route: `/w/${otherWsId}/settings/workspace/general`,
      routePath: '/*',
      tables: ['workspaces'],
      wrapper: DbWrapper,
    })

    const input = (await waitForElement(() =>
      (screen.getByLabelText('Workspace name') as HTMLInputElement).value === 'Old'
        ? screen.getByLabelText('Workspace name')
        : null,
    )) as HTMLInputElement
    await act(async () => {
      fireEvent.change(input, { target: { value: 'New name' } })
    })

    await flushAutosave()

    const db = getDb()
    const rows = await db.select().from(workspacesTable).where(eq(workspacesTable.id, otherWsId))
    expect(rows[0].name).toBe('New name')
  })

  it('skips autosave when the trimmed name is empty', async () => {
    await seedSharedWorkspaceWithMembership('admin', 'Acme')

    renderWithReactivity(<WorkspaceGeneralPage />, {
      route: `/w/${otherWsId}/settings/workspace/general`,
      routePath: '/*',
      tables: ['workspaces'],
      wrapper: DbWrapper,
    })

    const input = (await waitForElement(() =>
      (screen.getByLabelText('Workspace name') as HTMLInputElement).value === 'Acme'
        ? screen.getByLabelText('Workspace name')
        : null,
    )) as HTMLInputElement
    await act(async () => {
      fireEvent.change(input, { target: { value: '   ' } })
    })

    await flushAutosave()

    const db = getDb()
    const rows = await db.select().from(workspacesTable).where(eq(workspacesTable.id, otherWsId))
    // Original name preserved — debounced effect short-circuits on invalid input.
    expect(rows[0].name).toBe('Acme')
  })

  it('saves immediately on blur without waiting for the debounce', async () => {
    await seedSharedWorkspaceWithMembership('admin', 'Old')

    renderWithReactivity(<WorkspaceGeneralPage />, {
      route: `/w/${otherWsId}/settings/workspace/general`,
      routePath: '/*',
      tables: ['workspaces'],
      wrapper: DbWrapper,
    })

    const input = (await waitForElement(() =>
      (screen.getByLabelText('Workspace name') as HTMLInputElement).value === 'Old'
        ? screen.getByLabelText('Workspace name')
        : null,
    )) as HTMLInputElement

    await act(async () => {
      fireEvent.change(input, { target: { value: 'Blurred' } })
      fireEvent.blur(input)
    })
    // No clock tick — blur path doesn't wait for the debounce.
    await act(async () => {
      await getClock().runAllAsync()
    })

    const db = getDb()
    const rows = await db.select().from(workspacesTable).where(eq(workspacesTable.id, otherWsId))
    expect(rows[0].name).toBe('Blurred')
  })

  it('autosaves a Personal Workspace rename', async () => {
    // The canonical personal workspace at `wsId` is pre-seeded by
    // `resetTestDatabase`. Render the unprefixed route — `useActiveWorkspace`
    // falls back to the personal workspace owned by `testUserId`.

    renderWithReactivity(<WorkspaceGeneralPage />, {
      route: '/settings/workspace/general',
      routePath: '/*',
      tables: ['workspaces'],
      wrapper: DbWrapper,
    })

    const input = (await waitForElement(() =>
      (screen.getByLabelText('Workspace name') as HTMLInputElement).value === 'Personal'
        ? screen.getByLabelText('Workspace name')
        : null,
    )) as HTMLInputElement
    expect(input.disabled).toBe(false)
    await act(async () => {
      fireEvent.change(input, { target: { value: 'Home base' } })
    })

    await flushAutosave()

    const db = getDb()
    const rows = await db.select().from(workspacesTable).where(eq(workspacesTable.id, wsId))
    expect(rows[0].name).toBe('Home base')
  })
})
