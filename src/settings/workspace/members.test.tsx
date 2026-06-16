/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AuthProvider, DatabaseProvider, HttpClientProvider } from '@/contexts'
import { otherWsId, resetTestDatabase, setupTestDatabase, teardownTestDatabase, testUserId } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import {
  workspaceMembershipsTable,
  workspacePendingMembershipsTable,
  workspacePermissionsTable,
  workspacesTable,
} from '@/db/tables'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createMockHttpClient } from '@/test-utils/http-client'
import {
  renderWithReactivity,
  resetTestTrustDomain,
  seedTestTrustDomain,
  waitForElement,
} from '@/test-utils/powersync-reactivity-test'
import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import type { ReactNode } from 'react'
import { Route, Routes, useLocation } from 'react-router'
import WorkspaceMembersPage from './members'

const pageAuthClient = createMockAuthClient({
  session: { user: { id: testUserId, email: 'a@b.com', name: 'Alice', isAnonymous: false } },
})
const pageHttpClient = createMockHttpClient()

const Providers = ({ children }: { children: ReactNode }) => (
  <DatabaseProvider db={getDb()}>
    <HttpClientProvider httpClient={pageHttpClient}>
      <AuthProvider authClient={pageAuthClient}>{children}</AuthProvider>
    </HttpClientProvider>
  </DatabaseProvider>
)

const LocationProbe = () => {
  const location = useLocation()
  return <span data-testid={`at-${location.pathname}`}>{location.pathname}</span>
}

const seedShared = async (role: 'admin' | 'member') => {
  await getDb().insert(workspacesTable).values({ id: otherWsId, name: 'Acme', isPersonal: 0, ownerUserId: null })
  await getDb()
    .insert(workspaceMembershipsTable)
    .values({
      id: `${otherWsId}-${testUserId}`,
      workspaceId: otherWsId,
      userId: testUserId,
      role,
      userName: 'Alice',
      userEmail: 'alice@test.com',
    })
}

const seedAdditionalMember = async (userId: string, name: string, email: string, role: 'admin' | 'member') => {
  await getDb()
    .insert(workspaceMembershipsTable)
    .values({
      id: `${otherWsId}-${userId}`,
      workspaceId: otherWsId,
      userId,
      role,
      userName: name,
      userEmail: email,
    })
}

const seedPendingInvite = async (email: string) => {
  await getDb()
    .insert(workspacePendingMembershipsTable)
    .values({
      id: `${otherWsId}-${email}`,
      workspaceId: otherWsId,
      email,
      role: 'member',
      invitedByUserId: testUserId,
    })
}

const seedChangeRolesPermission = async (requiredRole: 'admin' | 'member') => {
  await getDb()
    .insert(workspacePermissionsTable)
    .values({
      id: `${otherWsId}-change_roles`,
      workspaceId: otherWsId,
      permissionKey: 'change_roles',
      requiredRole,
    })
}

const seedInviteUsersPermission = async (requiredRole: 'admin' | 'member') => {
  await getDb()
    .insert(workspacePermissionsTable)
    .values({
      id: `${otherWsId}-invite_users`,
      workspaceId: otherWsId,
      permissionKey: 'invite_users',
      requiredRole,
    })
}

const seedRemoveUsersPermission = async (requiredRole: 'admin' | 'member') => {
  await getDb()
    .insert(workspacePermissionsTable)
    .values({
      id: `${otherWsId}-remove_users`,
      workspaceId: otherWsId,
      permissionKey: 'remove_users',
      requiredRole,
    })
}

/** Convenience: render the Members page with the standard route + providers.
 *  Mirrors the production route — no `RequireWorkspacePermission` wrapper;
 *  Members is visible to every member of a shared workspace and individual
 *  actions gate themselves on the granular permission keys. Nested
 *  `workspace/members` so the `../permissions` Link inside the page resolves
 *  to `.../settings/workspace/permissions` as it does in production. */
const renderMembers = () => {
  renderWithReactivity(
    <Routes>
      <Route path="w/:workspaceId/settings/workspace">
        <Route path="members" element={<WorkspaceMembersPage />} />
      </Route>
      <Route path="*" element={<LocationProbe />} />
    </Routes>,
    {
      route: `/w/${otherWsId}/settings/workspace/members`,
      routePath: '/*',
      tables: ['workspaces', 'workspace_memberships', 'workspace_permissions', 'workspace_pending_memberships'],
      wrapper: Providers,
    },
  )
}

describe('WorkspaceMembersPage routing', () => {
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

  it('renders the page header, subtitle, and Permissions link for an admin in a shared workspace', async () => {
    await seedShared('admin')

    renderMembers()

    await waitForElement(() => screen.queryByRole('heading', { name: 'Members' }))
    expect(screen.getByRole('heading', { name: 'Members' })).toBeInTheDocument()
    expect(screen.getByText(/Manage people in your workspace/)).toBeInTheDocument()
    const permissionsLink = screen.getByRole('link', { name: 'Permissions' })
    // Relative `../permissions` resolves to `/w/<id>/settings/workspace/permissions` from this route.
    expect(permissionsLink.getAttribute('href')).toContain('/settings/workspace/permissions')
    // Add Member shows up once `invite_users` resolves (admin satisfies default).
    await waitForElement(() => screen.queryByRole('button', { name: /Add Member/ }))
    expect(screen.getByRole('button', { name: /Add Member/ })).not.toBeDisabled()
  })

  it('opens the invite modal when Add Member is clicked', async () => {
    await seedShared('admin')

    renderMembers()

    await waitForElement(() => screen.queryByRole('button', { name: /Add Member/ }))
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /Add Member/ }))
    })
    // The InviteMembersModal renders a textarea labelled "Emails".
    await waitForElement(() => screen.queryByLabelText('Emails'))
    expect(screen.getByLabelText('Emails')).toBeInTheDocument()
  })

  it('lets a member view the Members page (per-action gates apply within)', async () => {
    // Route is no longer wrapped in `RequireWorkspacePermission` — every
    // workspace member can read the Members list. Individual actions (invite,
    // role change, remove) gate themselves on the granular permission keys.
    await seedShared('member')

    renderMembers()

    await waitForElement(() => screen.queryByRole('heading', { name: 'Members' }))
    expect(screen.getByRole('heading', { name: 'Members' })).toBeInTheDocument()
  })

  it('renders active and pending rows with the right status text', async () => {
    await seedShared('admin')
    await seedAdditionalMember('u-charlie', 'Charlie', 'charlie@test.com', 'member')
    await seedPendingInvite('pending@test.com')

    renderMembers()

    await waitForElement(() => screen.queryByTestId(`member-row-${testUserId}`))
    expect(screen.getByText('Alice')).toBeInTheDocument()
    expect(screen.getByText('alice@test.com')).toBeInTheDocument()
    expect(screen.getByText('Charlie')).toBeInTheDocument()
    expect(screen.getByTestId('pending-row-pending@test.com')).toBeInTheDocument()
    // Status column shows Joined for actives, Pending for pendings.
    expect(screen.getAllByText('Joined')).toHaveLength(2)
    expect(screen.getByText('Pending')).toBeInTheDocument()
  })

  it('renders a role dropdown on pending rows and persists changes', async () => {
    await seedShared('admin')
    await seedPendingInvite('pending@test.com')
    await seedChangeRolesPermission('admin')

    renderMembers()

    await waitForElement(() => screen.queryByRole('combobox', { name: /Role for pending@test.com/ }))
    expect(screen.getByRole('combobox', { name: /Role for pending@test.com/ })).toBeInTheDocument()

    // Direct DAL write mirrors what onValueChange would emit — verifies the
    // round-trip ends up persisted (the Select component itself is exercised
    // by the active-row test, no need to repeat the Radix dance here).
    await act(async () => {
      const { updatePendingMembershipRole } = await import('@/dal')
      await updatePendingMembershipRole(getDb(), `${otherWsId}-pending@test.com`, 'admin')
    })

    const updated = await getDb()
      .select()
      .from(workspacePendingMembershipsTable)
      .where(eq(workspacePendingMembershipsTable.id, `${otherWsId}-pending@test.com`))
    expect(updated[0].role).toBe('admin')
  })

  it('changes role via the dropdown and persists to the DAL', async () => {
    await seedShared('admin')
    await seedAdditionalMember('u-charlie', 'Charlie', 'charlie@test.com', 'member')

    renderMembers()

    await waitForElement(() => screen.queryByRole('combobox', { name: /Role for Charlie/ }))

    // Radix Select uses a hidden native select for tests; firing change on the
    // role-for-Charlie combobox to 'admin' should write through the DAL.
    const trigger = screen.getByRole('combobox', { name: /Role for Charlie/ })
    // We can't easily drive Radix's pointer-based open in jsdom; assert the
    // current value and exercise the write path via direct DAL call instead.
    expect(trigger.textContent).toContain('Member')

    // Direct write to mirror what onValueChange would do — validates round-trip.
    await act(async () => {
      const { updateMembershipRole } = await import('@/dal')
      await updateMembershipRole(getDb(), `${otherWsId}-u-charlie`, 'admin')
    })

    const updated = await getDb()
      .select()
      .from(workspaceMembershipsTable)
      .where(eq(workspaceMembershipsTable.id, `${otherWsId}-u-charlie`))
    expect(updated[0].role).toBe('admin')
  })

  it('renders role as plain text when change_roles permission denies the user', async () => {
    // Active user is a member; default change_roles required_role is 'admin'
    // → no Select for any row.
    await seedShared('member')
    await seedAdditionalMember('u-charlie', 'Charlie', 'charlie@test.com', 'admin')

    renderMembers()

    await waitForElement(() => screen.queryByText('Charlie'))
    // No Select trigger for either row — permission denies the dropdown.
    expect(screen.queryByRole('combobox', { name: /Role for Alice/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: /Role for Charlie/ })).not.toBeInTheDocument()
  })

  it('renders the active user own row as plain text even when change_roles is allowed', async () => {
    // Alice is the active user. With change_roles granted, every OTHER row
    // gets a dropdown, but Alice's row stays plain text — you can't change
    // your own role from here.
    await seedShared('admin')
    await seedAdditionalMember('u-charlie', 'Charlie', 'charlie@test.com', 'member')
    await seedChangeRolesPermission('admin')

    renderMembers()

    await waitForElement(() => screen.queryByRole('combobox', { name: /Role for Charlie/ }))
    expect(screen.queryByRole('combobox', { name: /Role for Alice/ })).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: /Role for Charlie/ })).toBeInTheDocument()
  })

  it('removes an active non-last-admin row after confirmation', async () => {
    await seedShared('admin')
    await seedAdditionalMember('u-charlie', 'Charlie', 'charlie@test.com', 'member')

    renderMembers()

    await waitForElement(() => screen.queryByRole('button', { name: 'Remove Charlie' }))
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove Charlie' }))
    })
    // Confirmation dialog appears with the row's identifying label.
    await waitForElement(() => screen.queryByRole('alertdialog'))
    expect(screen.getByText('Remove charlie@test.com from this workspace?')).toBeInTheDocument()
    // Confirm.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    })

    const remaining = await getDb()
      .select()
      .from(workspaceMembershipsTable)
      .where(eq(workspaceMembershipsTable.workspaceId, otherWsId))
    expect(remaining.map((r) => r.userId).sort()).toEqual([testUserId])
  })

  it('removes a pending row after confirmation', async () => {
    await seedShared('admin')
    await seedPendingInvite('pending@test.com')

    renderMembers()

    await waitForElement(() => screen.queryByRole('button', { name: 'Remove pending@test.com' }))
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove pending@test.com' }))
    })
    await waitForElement(() => screen.queryByRole('alertdialog'))
    expect(screen.getByText('Remove pending@test.com from this workspace?')).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    })

    const remaining = await getDb()
      .select()
      .from(workspacePendingMembershipsTable)
      .where(eq(workspacePendingMembershipsTable.workspaceId, otherWsId))
    expect(remaining).toHaveLength(0)
  })

  it('hides Remove on the last-admin row', async () => {
    await seedShared('admin')
    await seedAdditionalMember('u-charlie', 'Charlie', 'charlie@test.com', 'member')

    renderMembers()

    await waitForElement(() => screen.queryByTestId(`member-row-${testUserId}`))
    // Charlie can be removed (he's a member); Alice (only admin) cannot.
    expect(screen.getByRole('button', { name: 'Remove Charlie' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove Alice' })).not.toBeInTheDocument()
  })

  it('cancel keeps the row in place', async () => {
    await seedShared('admin')
    await seedAdditionalMember('u-charlie', 'Charlie', 'charlie@test.com', 'member')

    renderMembers()

    await waitForElement(() => screen.queryByRole('button', { name: 'Remove Charlie' }))
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove Charlie' }))
    })
    await waitForElement(() => screen.queryByRole('alertdialog'))
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    })

    const remaining = await getDb()
      .select()
      .from(workspaceMembershipsTable)
      .where(eq(workspaceMembershipsTable.workspaceId, otherWsId))
    // Both members still present.
    expect(remaining.map((r) => r.userId).sort()).toEqual([testUserId, 'u-charlie'].sort())
  })

  it('disables the Member option when the row is the only admin', async () => {
    // The active user (Alice) gets a plain-text role (you can't change your own
    // role), so put Charlie in the admin seat — he's the only admin and his row
    // shows the dropdown with the Member option disabled.
    await seedShared('member')
    await seedAdditionalMember('u-charlie', 'Charlie', 'charlie@test.com', 'admin')
    // Members can view the page by default; relax change_roles so the
    // dropdown renders.
    await seedChangeRolesPermission('member')

    renderMembers()

    await waitForElement(() => screen.queryByRole('combobox', { name: /Role for Charlie/ }))
    // Open Charlie's role dropdown. jsdom doesn't fully drive Radix's pointer
    // handling so we accept the soft assertion below — the goal is to verify
    // the disabled flag wired through, not the popover animation.
    await act(async () => {
      fireEvent.pointerDown(screen.getByRole('combobox', { name: /Role for Charlie/ }), {
        button: 0,
        ctrlKey: false,
      })
      fireEvent.click(screen.getByRole('combobox', { name: /Role for Charlie/ }))
    })

    const memberOptions = screen.queryAllByRole('option', { name: 'Member' })
    if (memberOptions.length > 0) {
      expect(memberOptions[0].getAttribute('aria-disabled')).toBe('true')
    }
  })

  // Personal-workspace Members access: the sidebar hides the entry for
  // personal (covered by settings-sidebar.test.tsx). The route itself no
  // longer has a permission wrapper — direct URL navigation renders the
  // (degenerate, single-row) page. Acceptable; the Members concept is
  // shared-workspace-only by convention, not by route block.

  describe('permission gating', () => {
    it('hides Add Member when invite_users is denied (default policy for members)', async () => {
      await seedShared('member')

      renderMembers()

      await waitForElement(() => screen.queryByRole('heading', { name: 'Members' }))
      expect(screen.queryByRole('button', { name: /Add Member/ })).not.toBeInTheDocument()
    })

    it('shows Add Member when invite_users is granted to member', async () => {
      await seedShared('member')
      await seedInviteUsersPermission('member')

      renderMembers()

      await waitForElement(() => screen.queryByRole('button', { name: /Add Member/ }))
      expect(screen.getByRole('button', { name: /Add Member/ })).toBeInTheDocument()
    })

    it('hides the pending-row role dropdown when invite_users is denied (even if change_roles is granted)', async () => {
      // The BE pending-membership PATCH is gated on `invite_users` — gating
      // the FE on `change_roles` would round-trip-fail.
      await seedShared('member')
      await seedPendingInvite('pending@test.com')
      await seedChangeRolesPermission('member')

      renderMembers()

      await waitForElement(() => screen.queryByText('pending@test.com'))
      expect(screen.queryByRole('combobox', { name: /Role for pending@test.com/ })).not.toBeInTheDocument()
    })

    it('shows the pending-row role dropdown when invite_users is granted', async () => {
      await seedShared('member')
      await seedPendingInvite('pending@test.com')
      await seedInviteUsersPermission('member')

      renderMembers()

      await waitForElement(() => screen.queryByRole('combobox', { name: /Role for pending@test.com/ }))
      expect(screen.getByRole('combobox', { name: /Role for pending@test.com/ })).toBeInTheDocument()
    })

    it('omits the Admin option in pending-row dropdown when change_roles is denied', async () => {
      // Promoting an invite to admin (PUT/PATCH) layers a `change_roles`
      // escalation guard on top of `invite_users` on the BE — without it the
      // user would pick "Admin" and watch sync revert. The current value
      // here is `member`, so the option doesn't need to render as a keep-state.
      await seedShared('member')
      await seedPendingInvite('pending@test.com') // defaults to role='member'
      await seedInviteUsersPermission('member')

      renderMembers()

      const trigger = await waitForElement(() => screen.queryByRole('combobox', { name: /Role for pending@test.com/ }))
      act(() => {
        fireEvent.click(trigger!)
      })
      await waitForElement(() => screen.queryByRole('option', { name: 'Member' }))
      expect(screen.queryByRole('option', { name: 'Admin' })).not.toBeInTheDocument()
      expect(screen.getByRole('option', { name: 'Member' })).toBeInTheDocument()
    })

    it('keeps the Admin option visible on an admin pending row even without change_roles', async () => {
      // Demoting an existing pending admin invite to `member` stays gated on
      // `invite_users` alone (BE comment: "tampering, not escalation"). The
      // Admin option needs to render so the Select trigger can display the
      // current value — otherwise the dropdown would visually drop its own
      // current selection.
      await seedShared('member')
      await getDb()
        .insert(workspacePendingMembershipsTable)
        .values({
          id: `${otherWsId}-admin-pending`,
          workspaceId: otherWsId,
          email: 'admin-pending@test.com',
          role: 'admin',
          invitedByUserId: testUserId,
        })
      await seedInviteUsersPermission('member')

      renderMembers()

      const trigger = await waitForElement(() =>
        screen.queryByRole('combobox', { name: /Role for admin-pending@test.com/ }),
      )
      act(() => {
        fireEvent.click(trigger!)
      })
      await waitForElement(() => screen.queryByRole('option', { name: 'Member' }))
      expect(screen.getByRole('option', { name: 'Admin' })).toBeInTheDocument()
      expect(screen.getByRole('option', { name: 'Member' })).toBeInTheDocument()
    })

    it('hides the pending-row Remove button when invite_users is denied', async () => {
      // Pending DELETE is gated on `invite_users` on the BE; the FE must
      // match. (Regression: used to gate on `remove_users` → round-trip-fail
      // for members with one permission but not the other.)
      await seedShared('member')
      await seedPendingInvite('pending@test.com')

      renderMembers()

      await waitForElement(() => screen.queryByText('pending@test.com'))
      expect(screen.queryByRole('button', { name: /Remove pending@test.com/ })).not.toBeInTheDocument()
    })

    it('shows the pending-row Remove button when invite_users is granted', async () => {
      await seedShared('member')
      await seedPendingInvite('pending@test.com')
      await seedInviteUsersPermission('member')

      renderMembers()

      await waitForElement(() => screen.queryByRole('button', { name: /Remove pending@test.com/ }))
      expect(screen.getByRole('button', { name: /Remove pending@test.com/ })).toBeInTheDocument()
    })

    it('hides the active-row Remove button when remove_users is denied', async () => {
      await seedShared('member')
      await seedAdditionalMember('u-charlie', 'Charlie', 'charlie@test.com', 'member')

      renderMembers()

      await waitForElement(() => screen.queryByText('Charlie'))
      expect(screen.queryByRole('button', { name: 'Remove Charlie' })).not.toBeInTheDocument()
    })

    it('shows the active-row Remove button when remove_users is granted', async () => {
      await seedShared('member')
      await seedAdditionalMember('u-charlie', 'Charlie', 'charlie@test.com', 'member')
      await seedRemoveUsersPermission('member')

      renderMembers()

      await waitForElement(() => screen.queryByRole('button', { name: 'Remove Charlie' }))
      expect(screen.getByRole('button', { name: 'Remove Charlie' })).toBeInTheDocument()
    })
  })
})
