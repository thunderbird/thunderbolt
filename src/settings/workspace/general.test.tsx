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

  it('disables the name input for a non-admin member of a shared workspace', async () => {
    await seedSharedWorkspaceWithMembership('member', 'Acme')

    renderWithReactivity(<WorkspaceGeneralPage />, {
      route: `/w/${otherWsId}/settings/workspace/general`,
      routePath: '/*',
      tables: ['workspaces', 'workspace_memberships'],
      wrapper: DbWrapper,
    })

    const input = (await waitForElement(() =>
      (screen.getByLabelText('Workspace name') as HTMLInputElement).value === 'Acme'
        ? screen.getByLabelText('Workspace name')
        : null,
    )) as HTMLInputElement
    expect(input.disabled).toBe(true)
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

  it('hides the Workspace URL field on a Personal Workspace', async () => {
    renderWithReactivity(<WorkspaceGeneralPage />, {
      route: '/settings/workspace/general',
      routePath: '/*',
      tables: ['workspaces'],
      wrapper: DbWrapper,
    })

    await waitForElement(() => screen.queryByLabelText('Workspace name'))
    expect(screen.queryByLabelText('Workspace URL')).not.toBeInTheDocument()
  })

  it('auto-derives the slug from the workspace name on a fresh shared workspace', async () => {
    await seedSharedWorkspaceWithMembership('admin', 'Acme')

    renderWithReactivity(<WorkspaceGeneralPage />, {
      route: `/w/${otherWsId}/settings/workspace/general`,
      routePath: '/*',
      tables: ['workspaces'],
      wrapper: DbWrapper,
    })

    const nameInput = (await waitForElement(() =>
      (screen.getByLabelText('Workspace name') as HTMLInputElement).value === 'Acme'
        ? screen.getByLabelText('Workspace name')
        : null,
    )) as HTMLInputElement
    const slugInput = screen.getByLabelText('Workspace URL') as HTMLInputElement
    // Initial slug derived from name (workspace.slug is null on seed).
    expect(slugInput.value).toBe('acme')

    await act(async () => {
      fireEvent.change(nameInput, { target: { value: 'Engineering Team' } })
    })
    expect(slugInput.value).toBe('engineering-team')

    await flushAutosave()

    const db = getDb()
    const rows = await db.select().from(workspacesTable).where(eq(workspacesTable.id, otherWsId))
    expect(rows[0].name).toBe('Engineering Team')
    expect(rows[0].slug).toBe('engineering-team')
  })

  it('reflects remote sync updates into the form when the user has no in-progress edits', async () => {
    await seedSharedWorkspaceWithMembership('admin', 'Original')

    const { triggerChange } = renderWithReactivity(<WorkspaceGeneralPage />, {
      route: `/w/${otherWsId}/settings/workspace/general`,
      routePath: '/*',
      tables: ['workspaces'],
      wrapper: DbWrapper,
    })

    await waitForElement(() =>
      (screen.getByLabelText('Workspace name') as HTMLInputElement).value === 'Original'
        ? screen.getByLabelText('Workspace name')
        : null,
    )

    // Simulate a remote sync update — another device renamed the workspace.
    const db = getDb()
    await db.update(workspacesTable).set({ name: 'Remote Rename' }).where(eq(workspacesTable.id, otherWsId))
    await act(async () => {
      triggerChange(['workspaces'])
      await getClock().runAllAsync()
    })

    await waitForElement(() =>
      (screen.getByLabelText('Workspace name') as HTMLInputElement).value === 'Remote Rename'
        ? screen.getByLabelText('Workspace name')
        : null,
    )
    expect((screen.getByLabelText('Workspace name') as HTMLInputElement).value).toBe('Remote Rename')
  })

  it('does not clobber in-progress edits when a remote sync update arrives', async () => {
    await seedSharedWorkspaceWithMembership('admin', 'Original')

    const { triggerChange } = renderWithReactivity(<WorkspaceGeneralPage />, {
      route: `/w/${otherWsId}/settings/workspace/general`,
      routePath: '/*',
      tables: ['workspaces'],
      wrapper: DbWrapper,
    })

    const input = (await waitForElement(() =>
      (screen.getByLabelText('Workspace name') as HTMLInputElement).value === 'Original'
        ? screen.getByLabelText('Workspace name')
        : null,
    )) as HTMLInputElement

    // User starts typing — form is now dirty.
    await act(async () => {
      fireEvent.change(input, { target: { value: 'User typing…' } })
    })

    // Remote sync update arrives mid-edit.
    const db = getDb()
    await db.update(workspacesTable).set({ name: 'Remote Rename' }).where(eq(workspacesTable.id, otherWsId))
    await act(async () => {
      triggerChange(['workspaces'])
      await getClock().runAllAsync()
    })

    // The user's in-progress edit must survive — they win until they save.
    expect((screen.getByLabelText('Workspace name') as HTMLInputElement).value).toBe('User typing…')
  })

  it('stops auto-deriving the slug once the user edits it manually', async () => {
    await seedSharedWorkspaceWithMembership('admin', 'Acme')

    renderWithReactivity(<WorkspaceGeneralPage />, {
      route: `/w/${otherWsId}/settings/workspace/general`,
      routePath: '/*',
      tables: ['workspaces'],
      wrapper: DbWrapper,
    })

    const nameInput = (await waitForElement(() =>
      (screen.getByLabelText('Workspace name') as HTMLInputElement).value === 'Acme'
        ? screen.getByLabelText('Workspace name')
        : null,
    )) as HTMLInputElement
    const slugInput = screen.getByLabelText('Workspace URL') as HTMLInputElement

    // User customises slug → lock auto-derivation.
    await act(async () => {
      fireEvent.change(slugInput, { target: { value: 'custom-slug' } })
    })
    expect(slugInput.value).toBe('custom-slug')

    // Now change name — slug should NOT auto-update.
    await act(async () => {
      fireEvent.change(nameInput, { target: { value: 'Different Name' } })
    })
    expect(slugInput.value).toBe('custom-slug')
  })
})
