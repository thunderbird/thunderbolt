/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { DatabaseProvider } from '@/contexts'
import { getDb } from '@/db/database'
import { workspacePendingMembershipsTable, workspacesTable } from '@/db/tables'
import {
  renderWithReactivity,
  resetTestTrustDomain,
  seedTestTrustDomain,
  waitForElement,
} from '@/test-utils/powersync-reactivity-test'
import '@testing-library/jest-dom'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { useWorkspacePendingMembershipsQuery } from './workspace-pending-memberships'
import { otherWsId, resetTestDatabase, setupTestDatabase, teardownTestDatabase, testUserId, wsId } from './test-utils'

const DbWrapper = ({ children }: { children: ReactNode }) => (
  <DatabaseProvider db={getDb()}>{children}</DatabaseProvider>
)

const seedSharedWorkspace = async (id: string) => {
  const db = getDb()
  await db.insert(workspacesTable).values({ id, name: 'Shared', isPersonal: 0, ownerUserId: null })
}

const seedPending = async (workspaceId: string, email: string) => {
  const db = getDb()
  await db.insert(workspacePendingMembershipsTable).values({
    id: `${workspaceId}-${email}`,
    workspaceId,
    email,
    role: 'member',
    invitedByUserId: testUserId,
  })
}

describe('useWorkspacePendingMembershipsQuery', () => {
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

  const Probe = ({ workspaceId }: { workspaceId: string | undefined }) => {
    const pending = useWorkspacePendingMembershipsQuery(workspaceId)
    if (pending.length === 0) {
      return null
    }
    return (
      <ul>
        {pending.map((p) => (
          <li key={p.id} data-testid={`p-row-${p.email}`}>
            {p.email}
          </li>
        ))}
      </ul>
    )
  }

  it('returns pending rows scoped to the workspace, sorted by email', async () => {
    await seedSharedWorkspace(otherWsId)
    await seedPending(otherWsId, 'charlie@test.com')
    await seedPending(otherWsId, 'alice@test.com')
    // Cross-workspace pending row that must be excluded.
    await seedPending(wsId, 'bob@test.com')

    renderWithReactivity(<Probe workspaceId={otherWsId} />, {
      tables: ['workspace_pending_memberships'],
      wrapper: DbWrapper,
    })

    await waitForElement(() => screen.queryByTestId('p-row-alice@test.com'))
    const rows = screen.getAllByText(/^(alice|charlie|bob)@test\.com$/)
    expect(rows.map((el) => el.textContent)).toEqual(['alice@test.com', 'charlie@test.com'])
    expect(screen.queryByTestId('p-row-bob@test.com')).not.toBeInTheDocument()
  })

  it('returns empty array when workspaceId is undefined', async () => {
    await seedSharedWorkspace(otherWsId)
    await seedPending(otherWsId, 'alice@test.com')

    renderWithReactivity(<Probe workspaceId={undefined} />, {
      tables: ['workspace_pending_memberships'],
      wrapper: DbWrapper,
    })

    expect(screen.queryByTestId('p-row-alice@test.com')).not.toBeInTheDocument()
  })
})
