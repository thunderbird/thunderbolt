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
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { useState, type ReactNode } from 'react'
import { CreateWorkspaceModal } from './create-workspace-modal'

const session = { user: { id: testUserId, email: 'creator@test.com', name: 'Creator', isAnonymous: false } }

const Harness = ({ initialOpen = true }: { initialOpen?: boolean }) => {
  const [open, setOpen] = useState(initialOpen)
  return (
    <>
      <button onClick={() => setOpen(true)}>open</button>
      <CreateWorkspaceModal open={open} onOpenChange={setOpen} />
      <div data-testid="open">{open ? 'yes' : 'no'}</div>
    </>
  )
}

const LocationProbe = () => {
  const { pathname } = useLocation()
  return <div data-testid="pathname">{pathname}</div>
}

// Minimal wrapper that gives the modal exactly what it needs (DB + QueryClient
// + auth client) without mounting `<AuthProvider>` — the latter triggers
// `runPostAuthBootstrap` → `reconcileDefaults`, whose async transaction races
// the modal's own transaction and bun:sqlite rejects nested transactions.
const wrap = (children: ReactNode) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  })
  return (
    <DatabaseProvider db={getDb()}>
      <QueryClientProvider client={queryClient}>
        <AuthContext.Provider value={{ authClient: createMockAuthClient({ session }) }}>
          <MemoryRouter initialEntries={['/chats/new']}>
            <Routes>
              <Route
                path="/*"
                element={
                  <>
                    {children}
                    <LocationProbe />
                  </>
                }
              />
            </Routes>
          </MemoryRouter>
        </AuthContext.Provider>
      </QueryClientProvider>
    </DatabaseProvider>
  )
}

describe('CreateWorkspaceModal', () => {
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

  it('disables Continue when name is empty / whitespace-only', () => {
    render(wrap(<Harness />))
    const cont = screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement
    expect(cont).toBeDisabled()

    const input = screen.getByLabelText('Workspace name')
    fireEvent.change(input, { target: { value: '   ' } })
    expect(cont).toBeDisabled()

    fireEvent.change(input, { target: { value: 'Engineering' } })
    expect(cont).not.toBeDisabled()
  })

  it('advances to invite step on Continue', () => {
    render(wrap(<Harness />))
    fireEvent.change(screen.getByLabelText('Workspace name'), { target: { value: 'Engineering' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(screen.getByLabelText('Invite by email')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /create workspace/i })).toBeInTheDocument()
  })

  it('Back returns to the name step keeping the entered name', () => {
    render(wrap(<Harness />))
    fireEvent.change(screen.getByLabelText('Workspace name'), { target: { value: 'Engineering' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByLabelText('Workspace name')).toHaveValue('Engineering')
  })

  it('Skip creates the workspace with no invites + closes + navigates', async () => {
    render(wrap(<Harness />))
    fireEvent.change(screen.getByLabelText('Workspace name'), { target: { value: 'Acme' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    })

    await waitFor(() => expect(screen.getByTestId('open')).toHaveTextContent('no'))

    const db = getDb()
    const wsRows = await db.select().from(workspacesTable).where(eq(workspacesTable.name, 'Acme'))
    expect(wsRows).toHaveLength(1)
    const memberships = await db
      .select()
      .from(workspaceMembershipsTable)
      .where(eq(workspaceMembershipsTable.workspaceId, wsRows[0].id))
    expect(memberships).toHaveLength(1)
    expect(memberships[0].userId).toBe(testUserId)
    expect(memberships[0].role).toBe('admin')

    const pending = await db
      .select()
      .from(workspacePendingMembershipsTable)
      .where(eq(workspacePendingMembershipsTable.workspaceId, wsRows[0].id))
    expect(pending).toHaveLength(0)

    expect(screen.getByTestId('pathname').textContent).toBe(`/w/${wsRows[0].id}/`)
  })

  it('Create Workspace writes one pending row per invited email', async () => {
    render(wrap(<Harness />))
    fireEvent.change(screen.getByLabelText('Workspace name'), { target: { value: 'Acme' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    const emails = screen.getByLabelText('Invite by email')
    fireEvent.change(emails, { target: { value: 'a@test.com' } })
    fireEvent.keyDown(emails, { key: 'Enter' })
    fireEvent.change(emails, { target: { value: 'b@test.com' } })
    fireEvent.keyDown(emails, { key: 'Enter' })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /create workspace/i }))
    })

    await waitFor(() => expect(screen.getByTestId('open')).toHaveTextContent('no'))

    const db = getDb()
    const wsRows = await db.select().from(workspacesTable).where(eq(workspacesTable.name, 'Acme'))
    const pending = await db
      .select()
      .from(workspacePendingMembershipsTable)
      .where(eq(workspacePendingMembershipsTable.workspaceId, wsRows[0].id))
    const sortedEmails = pending.map((p) => p.email).sort()
    expect(sortedEmails).toEqual(['a@test.com', 'b@test.com'])
  })

  it('filters the creator email out of invited emails', async () => {
    render(wrap(<Harness />))
    fireEvent.change(screen.getByLabelText('Workspace name'), { target: { value: 'SelfInvite' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    const emails = screen.getByLabelText('Invite by email')
    fireEvent.change(emails, { target: { value: 'creator@test.com' } })
    fireEvent.keyDown(emails, { key: 'Enter' })
    fireEvent.change(emails, { target: { value: 'other@test.com' } })
    fireEvent.keyDown(emails, { key: 'Enter' })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /create workspace/i }))
    })

    await waitFor(() => expect(screen.getByTestId('open')).toHaveTextContent('no'))

    const db = getDb()
    const wsRows = await db.select().from(workspacesTable).where(eq(workspacesTable.name, 'SelfInvite'))
    const pending = await db
      .select()
      .from(workspacePendingMembershipsTable)
      .where(eq(workspacePendingMembershipsTable.workspaceId, wsRows[0].id))
    expect(pending.map((p) => p.email)).toEqual(['other@test.com'])
  })

  it('Cancel closes without writing anything', async () => {
    render(wrap(<Harness />))
    fireEvent.change(screen.getByLabelText('Workspace name'), { target: { value: 'Nope' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.getByTestId('open')).toHaveTextContent('no'))

    const db = getDb()
    const wsRows = await db.select().from(workspacesTable).where(eq(workspacesTable.name, 'Nope'))
    expect(wsRows).toHaveLength(0)
  })
})
