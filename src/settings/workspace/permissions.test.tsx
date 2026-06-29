/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AuthProvider, DatabaseProvider, HttpClientProvider } from '@/contexts'
import { otherWsId, resetTestDatabase, setupTestDatabase, teardownTestDatabase, testUserId } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import type { WorkspacePermissionKey } from '@/dal'
import { workspaceMembershipsTable, workspacePermissionsTable, workspacesTable } from '@/db/tables'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createMockHttpClient } from '@/test-utils/http-client'
import {
  renderWithReactivity,
  resetTestTrustDomain,
  seedTestTrustDomain,
  waitForElement,
} from '@/test-utils/powersync-reactivity-test'
import '@testing-library/jest-dom'
import { cleanup, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import type { ReactNode } from 'react'
import { Route, Routes } from 'react-router'
import WorkspacePermissionsPage from './permissions'

const authClient = createMockAuthClient({
  session: { user: { id: testUserId, email: 'a@b.com', name: 'Alice', isAnonymous: false } },
})
const httpClient = createMockHttpClient()

const Providers = ({ children }: { children: ReactNode }) => (
  <DatabaseProvider db={getDb()}>
    <HttpClientProvider httpClient={httpClient}>
      <AuthProvider authClient={authClient}>{children}</AuthProvider>
    </HttpClientProvider>
  </DatabaseProvider>
)

const seedAdminInShared = async () => {
  await getDb().insert(workspacesTable).values({ id: otherWsId, name: 'Acme', isPersonal: 0, ownerUserId: null })
  await getDb()
    .insert(workspaceMembershipsTable)
    .values({
      id: `${otherWsId}-${testUserId}`,
      workspaceId: otherWsId,
      userId: testUserId,
      role: 'admin',
    })
}

const seedPermissionRow = async (key: WorkspacePermissionKey, requiredRole: 'admin' | 'member') => {
  await getDb()
    .insert(workspacePermissionsTable)
    .values({
      id: `${otherWsId}-${key}`,
      workspaceId: otherWsId,
      permissionKey: key,
      requiredRole,
    })
}

const expectedRows: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'invite_users', label: 'Invite Users' },
  { key: 'change_roles', label: 'Change Roles' },
  { key: 'remove_users', label: 'Remove Users' },
  { key: 'add_agents', label: 'Add Agents' },
  { key: 'remove_agents', label: 'Remove Agents' },
  { key: 'add_skills', label: 'Add Skills' },
  { key: 'remove_skills', label: 'Remove Skills' },
  { key: 'add_models', label: 'Add Models' },
  { key: 'remove_models', label: 'Remove Models' },
]

const renderPage = () => {
  renderWithReactivity(
    <Routes>
      <Route path="w/:workspaceId/settings/workspace">
        <Route path="permissions" element={<WorkspacePermissionsPage />} />
      </Route>
    </Routes>,
    {
      route: `/w/${otherWsId}/settings/workspace/permissions`,
      routePath: '/*',
      tables: ['workspaces', 'workspace_memberships', 'workspace_permissions'],
      wrapper: Providers,
    },
  )
}

const readRequiredRole = async (key: WorkspacePermissionKey) => {
  const rows = await getDb()
    .select()
    .from(workspacePermissionsTable)
    .where(and(eq(workspacePermissionsTable.workspaceId, otherWsId), eq(workspacePermissionsTable.permissionKey, key)))
  return rows[0]?.requiredRole
}

describe('WorkspacePermissionsPage', () => {
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

  it('renders the page header and one row per permission key (labels only, no descriptions)', async () => {
    await seedAdminInShared()

    renderPage()

    await waitForElement(() => screen.queryByRole('heading', { name: 'Permissions' }))
    expect(screen.getByRole('heading', { name: 'Permissions' })).toBeInTheDocument()
    expect(screen.getByText(/Only owners can manage permissions/)).toBeInTheDocument()
    for (const { key, label } of expectedRows) {
      expect(screen.getByTestId(`permission-row-${key}`)).toBeInTheDocument()
      expect(screen.getByText(label)).toBeInTheDocument()
    }
    // Legacy / out-of-scope keys are not surfaced on the page.
    expect(screen.queryByTestId('permission-row-manage_members')).not.toBeInTheDocument()
    expect(screen.queryByTestId('permission-row-delete_workspace')).not.toBeInTheDocument()
  })

  it('reflects the current requiredRole from existing workspace_permissions rows', async () => {
    await seedAdminInShared()
    await seedPermissionRow('add_agents', 'member')
    await seedPermissionRow('remove_agents', 'admin')
    await seedPermissionRow('add_skills', 'member')

    renderPage()

    // Wait until the live query lands the seeded `member` value on one of the
    // rows — fallback "Admin" renders before the query resolves. `member` is
    // surfaced in the UI as "Everyone".
    await waitForElement(() => {
      const trigger = screen.queryByRole('combobox', { name: /Required role for Add Agents/ })
      return trigger?.textContent?.includes('Everyone') ? trigger : null
    })
    expect(screen.getByRole('combobox', { name: /Required role for Add Agents/ })).toHaveTextContent('Everyone')
    expect(screen.getByRole('combobox', { name: /Required role for Remove Agents/ })).toHaveTextContent('Admin')
    expect(screen.getByRole('combobox', { name: /Required role for Add Skills/ })).toHaveTextContent('Everyone')
  })

  it('falls back to Admin in the select for keys with no permission row', async () => {
    await seedAdminInShared()

    renderPage()

    await waitForElement(() => screen.queryByRole('combobox', { name: /Required role for Add Agents/ }))
    expect(screen.getByRole('combobox', { name: /Required role for Add Agents/ })).toHaveTextContent('Admin')
    expect(screen.getByRole('combobox', { name: /Required role for Remove Skills/ })).toHaveTextContent('Admin')
  })

  it('persists a role change through setWorkspacePermissionRequiredRole (upserts when no row exists)', async () => {
    await seedAdminInShared()

    renderPage()

    await waitForElement(() => screen.queryByRole('heading', { name: 'Permissions' }))

    // The Radix Select trigger is hard to drive deterministically in jsdom +
    // PowerSync's reactive setup. The selector itself is exercised in the
    // page-render test above; here we verify the round-trip via a direct DAL
    // call (matches what `onValueChange` would emit) so we still cover the
    // upsert behaviour the page relies on.
    const { setWorkspacePermissionRequiredRole } = await import('@/dal')
    await setWorkspacePermissionRequiredRole(getDb(), otherWsId, 'add_agents', 'member')

    expect(await readRequiredRole('add_agents')).toBe('member')
  })
})
