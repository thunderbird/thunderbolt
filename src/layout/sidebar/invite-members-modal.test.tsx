/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { DatabaseProvider } from '@/contexts'
import { AuthContext } from '@/contexts/auth-context'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase, testUserId } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { workspaceMembershipsTable, workspacePendingMembershipsTable, workspacesTable } from '@/db/tables'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@testing-library/jest-dom'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { eq } from 'drizzle-orm'
import { MemoryRouter } from 'react-router'
import { useState, type ReactNode } from 'react'
import { v7 as uuidv7 } from 'uuid'
import { InviteMembersModal } from './invite-members-modal'

const session = { user: { id: testUserId, email: 'creator@test.com', name: 'Creator', isAnonymous: false } }

const seedSharedWorkspace = async (): Promise<string> => {
  const db = getDb()
  const id = uuidv7()
  await db.insert(workspacesTable).values({ id, name: 'Test', isPersonal: 0, ownerUserId: null })
  await db.insert(workspaceMembershipsTable).values({
    id: uuidv7(),
    workspaceId: id,
    userId: testUserId,
    role: 'admin',
  })
  return id
}

const Harness = ({ workspaceId }: { workspaceId: string }) => {
  const [open, setOpen] = useState(true)
  return (
    <>
      <InviteMembersModal open={open} workspaceId={workspaceId} onClose={() => setOpen(false)} />
      <div data-testid="open">{open ? 'yes' : 'no'}</div>
    </>
  )
}

const wrap = (children: ReactNode) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  })
  return (
    <DatabaseProvider db={getDb()}>
      <QueryClientProvider client={queryClient}>
        <AuthContext.Provider value={{ authClient: createMockAuthClient({ session }) }}>
          <MemoryRouter initialEntries={['/']}>{children}</MemoryRouter>
        </AuthContext.Provider>
      </QueryClientProvider>
    </DatabaseProvider>
  )
}

describe('InviteMembersModal', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    await resetTestDatabase()
  })

  afterEach(() => {
    cleanup()
  })

  it('Send invites is disabled with empty textarea, enabled when valid email is present', async () => {
    const workspaceId = await seedSharedWorkspace()
    render(wrap(<Harness workspaceId={workspaceId} />))
    const send = screen.getByRole('button', { name: /send invites/i }) as HTMLButtonElement
    expect(send).toBeDisabled()

    fireEvent.change(screen.getByLabelText('Emails'), { target: { value: 'a@test.com' } })
    expect(send).not.toBeDisabled()
  })

  it('Send invites stays disabled when any invalid email is present', async () => {
    const workspaceId = await seedSharedWorkspace()
    render(wrap(<Harness workspaceId={workspaceId} />))
    const send = screen.getByRole('button', { name: /send invites/i }) as HTMLButtonElement

    fireEvent.change(screen.getByLabelText('Emails'), { target: { value: 'good@test.com, not-an-email' } })
    expect(send).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent(/not-an-email/i)

    // Fix the invalid one — button enables.
    fireEvent.change(screen.getByLabelText('Emails'), { target: { value: 'good@test.com, also@test.com' } })
    expect(send).not.toBeDisabled()
  })

  it('Send invites is disabled when textarea only contains separators / whitespace', async () => {
    const workspaceId = await seedSharedWorkspace()
    render(wrap(<Harness workspaceId={workspaceId} />))
    const send = screen.getByRole('button', { name: /send invites/i }) as HTMLButtonElement

    fireEvent.change(screen.getByLabelText('Emails'), { target: { value: '   ,;   ' } })
    expect(send).toBeDisabled()
  })

  it('Skip for now closes the modal without writing pending rows', async () => {
    const workspaceId = await seedSharedWorkspace()
    render(wrap(<Harness workspaceId={workspaceId} />))
    fireEvent.change(screen.getByLabelText('Emails'), { target: { value: 'a@test.com' } })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /skip for now/i }))
    })

    await waitFor(() => expect(screen.getByTestId('open')).toHaveTextContent('no'))
    const db = getDb()
    const pending = await db
      .select()
      .from(workspacePendingMembershipsTable)
      .where(eq(workspacePendingMembershipsTable.workspaceId, workspaceId))
    expect(pending).toHaveLength(0)
  })

  it('Send invites writes one pending row per valid email + closes', async () => {
    const workspaceId = await seedSharedWorkspace()
    render(wrap(<Harness workspaceId={workspaceId} />))
    fireEvent.change(screen.getByLabelText('Emails'), { target: { value: 'a@test.com, b@test.com' } })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /send invites/i }))
    })

    await waitFor(() => expect(screen.getByTestId('open')).toHaveTextContent('no'))
    const db = getDb()
    const pending = await db
      .select()
      .from(workspacePendingMembershipsTable)
      .where(eq(workspacePendingMembershipsTable.workspaceId, workspaceId))
    expect(pending.map((p) => p.email).sort()).toEqual(['a@test.com', 'b@test.com'])
  })

  it('filters the creator email out of the invite list', async () => {
    const workspaceId = await seedSharedWorkspace()
    render(wrap(<Harness workspaceId={workspaceId} />))
    fireEvent.change(screen.getByLabelText('Emails'), {
      target: { value: 'creator@test.com, friend@test.com' },
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /send invites/i }))
    })

    await waitFor(() => expect(screen.getByTestId('open')).toHaveTextContent('no'))
    const db = getDb()
    const pending = await db
      .select()
      .from(workspacePendingMembershipsTable)
      .where(eq(workspacePendingMembershipsTable.workspaceId, workspaceId))
    expect(pending.map((p) => p.email)).toEqual(['friend@test.com'])
  })
})
