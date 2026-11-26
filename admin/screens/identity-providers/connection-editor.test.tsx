/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import type { AdminConnectionDetail, AuditEvent, ScimGroup } from '@shared/admin-api'
import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import type { ResourcePageState } from '../../components/use-resource-page-state'
import { createAdminTestHarness, flush, type FakeReply, type FakeRequest } from '../../test-utils'
import { ConnectionEditor } from './connection-editor'

const detail: AdminConnectionDetail = {
  id: 'c1',
  name: 'Acme SCIM',
  status: 'active',
  matchClaim: 'sub',
  sso: null,
  scim: { scimConnectionId: 's1' },
  claimedDomains: [],
  createdAt: '2026-11-17T00:00:00.000Z',
  lockedFields: [],
  scimCredentials: [],
}

const group: ScimGroup = { id: 'grp-1', displayName: 'Engineering', externalId: 'ext-1', memberCount: 3, roles: [] }

const failure: AuditEvent = {
  id: 'e1',
  orgId: 'org',
  occurredAt: '2026-11-17T00:00:00.000Z',
  action: 'scim.request',
  outcome: 'failure',
  reason: 'invalidValue',
  actorType: 'scim_connection',
  actorId: 'c1',
  targetType: 'scim_user',
  targetId: null,
  connectionId: 'c1',
  credentialId: 'cred-1',
  requestId: null,
  reportSource: 'server',
  changes: null,
  metadata: { method: 'POST', resourceType: 'Users', status: 400, detail: 'externalId is required' },
  ipAddress: null,
  actorLabel: null,
  targetLabel: null,
  userAgent: null,
}

const backend = ({ path }: FakeRequest): FakeReply => {
  if (path === 'admin/connections/c1') {
    return { body: detail }
  }
  if (path === 'admin/connections/c1/scim-groups') {
    return { body: { items: [group], nextCursor: null } }
  }
  if (path === 'admin/role-mappings') {
    return { body: { items: [] } }
  }
  if (path === 'admin/audit-events') {
    return { body: { events: [failure], nextCursor: null } }
  }
  return {}
}

const page = { patch: () => {}, close: () => {} } as unknown as ResourcePageState

const renderEditor = (state: ResourcePageState = page) => {
  const harness = createAdminTestHarness(backend)
  render(<ConnectionEditor connectionId="c1" page={state} onRetireScim={() => {}} />, { wrapper: harness.wrapper })
  return harness
}

describe('ConnectionEditor', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)
  afterEach(() => {
    cleanup()
  })

  it('offers no rename and only Retire SCIM on a SCIM-only connection', async () => {
    renderEditor()
    await flush()
    expect(screen.getByRole('heading', { name: 'Acme SCIM' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Name')).toBeNull()
    fireEvent.pointerDown(screen.getByRole('button', { name: 'More' }), { button: 0, ctrlKey: false })
    expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent)).toEqual(['Retire SCIM'])
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.getByRole('button', { name: 'Add OIDC sign-in' })).toBeInTheDocument()
  })

  it('maps each SCIM group by its id', async () => {
    const harness = renderEditor()
    await flush()
    fireEvent.click(screen.getByRole('radio', { name: 'Groups' }))
    await flush()

    const row = screen.getByRole('listitem', { name: 'Engineering' })
    expect(within(row).getByText('grp-1')).toBeInTheDocument()
    expect(within(row).getByText('3 members')).toBeInTheDocument()
    fireEvent.click(within(row).getByRole('switch', { name: 'Make members of Engineering admins' }))
    await flush()
    expect(harness.requests.find((request) => request.method === 'POST')?.body).toEqual({
      identityConnectionId: 'c1',
      scimGroupId: 'grp-1',
      role: 'admin',
    })
  })

  it('lists rejected SCIM requests and links to them in the audit log', async () => {
    const harness = renderEditor()
    await flush()
    fireEvent.click(screen.getByRole('radio', { name: 'Sync errors' }))
    await flush()

    const query = harness.requests.find((request) => request.path === 'admin/audit-events')?.search
    expect(Object.fromEntries(query ?? [])).toEqual({ action: 'scim.request', outcome: 'failure', connectionId: 'c1' })
    expect(screen.getByText('POST Users → 400')).toBeInTheDocument()
    expect(screen.getByText('externalId is required')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'See all in the audit log' })).toHaveAttribute(
      'href',
      '/admin/audit-log?action=scim.request&outcome=failure&connectionId=c1',
    )
  })

  it('asks before a tab change drops unsaved work, such as a token not yet copied', async () => {
    const patches: unknown[] = []
    renderEditor({ ...page, dirty: true, patch: (update: unknown) => patches.push(update) } as ResourcePageState)
    await flush()

    fireEvent.click(screen.getByRole('radio', { name: 'Groups' }))
    await flush()
    expect(screen.getByText('Leave without saving?')).toBeInTheDocument()
    expect(screen.getByText('Add OIDC sign-in')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    await flush()
    expect(patches).toContainEqual({ dirty: false })
    expect(screen.getByRole('listitem', { name: 'Engineering' })).toBeInTheDocument()
  })
})
