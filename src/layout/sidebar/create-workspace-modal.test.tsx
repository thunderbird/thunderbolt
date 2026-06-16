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
import { CreateWorkspaceModal } from './create-workspace-modal'

const session = { user: { id: testUserId, email: 'creator@test.com', name: 'Creator', isAnonymous: false } }

const Harness = ({ initialOpen = true }: { initialOpen?: boolean }) => {
  const [open, setOpen] = useState(initialOpen)
  const [createdId, setCreatedId] = useState<string | null>(null)
  // Mirror the real WorkspaceSelector behavior — onCreated closes the modal.
  const handleCreated = (id: string) => {
    setOpen(false)
    setCreatedId(id)
  }
  return (
    <>
      <CreateWorkspaceModal open={open} onOpenChange={setOpen} onCreated={handleCreated} />
      <div data-testid="open">{open ? 'yes' : 'no'}</div>
      <div data-testid="created-id">{createdId ?? ''}</div>
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
          <MemoryRouter initialEntries={['/chats/new']}>{children}</MemoryRouter>
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

  it('disables Create when name is empty / whitespace-only', () => {
    render(wrap(<Harness />))
    const cta = screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement
    expect(cta).toBeDisabled()

    const input = screen.getByLabelText('Workspace name')
    fireEvent.change(input, { target: { value: '   ' } })
    expect(cta).toBeDisabled()

    fireEvent.change(input, { target: { value: 'Engineering' } })
    expect(cta).not.toBeDisabled()
  })

  it('Create writes workspace + admin membership + seeds defaults; calls onCreated and closes', async () => {
    render(wrap(<Harness />))
    fireEvent.change(screen.getByLabelText('Workspace name'), { target: { value: 'Acme' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    })

    await waitFor(() => expect(screen.getByTestId('open')).toHaveTextContent('no'))

    const db = getDb()
    const wsRows = await db.select().from(workspacesTable).where(eq(workspacesTable.name, 'Acme'))
    expect(wsRows).toHaveLength(1)
    expect(wsRows[0].isPersonal).toBe(0)

    const memberships = await db
      .select()
      .from(workspaceMembershipsTable)
      .where(eq(workspaceMembershipsTable.workspaceId, wsRows[0].id))
    expect(memberships).toHaveLength(1)
    expect(memberships[0].userId).toBe(testUserId)
    expect(memberships[0].role).toBe('admin')

    // No pending memberships — that's the invite modal's job now.
    const pending = await db
      .select()
      .from(workspacePendingMembershipsTable)
      .where(eq(workspacePendingMembershipsTable.workspaceId, wsRows[0].id))
    expect(pending).toHaveLength(0)

    expect(screen.getByTestId('created-id').textContent).toBe(wsRows[0].id)
  })

  it('submits via the form (Enter key in a real browser) once name is filled', async () => {
    render(wrap(<Harness />))
    const input = screen.getByLabelText('Workspace name') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Enter Submit' } })
    const formEl = input.closest('form')
    expect(formEl).not.toBeNull()
    await act(async () => {
      // Browsers implicitly submit a single-input form on Enter; jsdom doesn't
      // bridge keydown → submit, so fire the form's submit event directly.
      fireEvent.submit(formEl!)
    })

    await waitFor(() => expect(screen.getByTestId('open')).toHaveTextContent('no'))
    const db = getDb()
    const wsRows = await db.select().from(workspacesTable).where(eq(workspacesTable.name, 'Enter Submit'))
    expect(wsRows).toHaveLength(1)
  })
})
