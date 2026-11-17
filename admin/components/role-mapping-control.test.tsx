/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import type { RoleMapping } from '@shared/admin-api'
import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { createAdminTestHarness, flush, type FakeRequest, type FakeReply } from '../test-utils'
import { RoleMappingControl } from './role-mapping-control'

const groupMapping: RoleMapping = {
  id: 'm1',
  role: 'admin',
  target: { kind: 'local_group', groupId: 'g1', name: 'Ops' },
  createdAt: '2026-11-17T00:00:00.000Z',
}

/** A backend holding `mappings`, answering deletes with `deleteReply`. */
const backend =
  (mappings: RoleMapping[], deleteReply: FakeReply = { body: {} }) =>
  ({ method, path }: FakeRequest): FakeReply => {
    if (method === 'GET' && path === 'admin/role-mappings') {
      return { body: { items: mappings } }
    }
    if (method === 'DELETE') {
      return deleteReply
    }
    return { body: { ...groupMapping } }
  }

const renderControl = (harness: ReturnType<typeof createAdminTestHarness>, target = { localGroupId: 'g1' }) =>
  render(<RoleMappingControl target={target} groupName="Ops" />, { wrapper: harness.wrapper })

describe('RoleMappingControl', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)
  afterEach(() => {
    cleanup()
  })

  it('maps an unmapped group to admin', async () => {
    const harness = createAdminTestHarness(backend([]))
    renderControl(harness)
    await flush()

    const toggle = screen.getByRole('switch', { name: 'Make members of Ops admins' })
    expect(toggle).not.toBeChecked()
    fireEvent.click(toggle)
    await flush()

    const create = harness.requests.find((request) => request.method === 'POST')
    expect(create).toMatchObject({ path: 'admin/role-mappings', body: { localGroupId: 'g1', role: 'admin' } })
  })

  it('maps a SCIM group by its id', async () => {
    const harness = createAdminTestHarness(backend([]))
    renderControl(harness, { identityConnectionId: 'c1', scimGroupId: 's1' } as never)
    await flush()

    expect(harness.requests[0].search.get('connectionId')).toBe('c1')
    fireEvent.click(screen.getByRole('switch'))
    await flush()
    expect(harness.requests.find((request) => request.method === 'POST')?.body).toEqual({
      identityConnectionId: 'c1',
      scimGroupId: 's1',
      role: 'admin',
    })
  })

  it('removes the mapping and warns when no local admin is left', async () => {
    const harness = createAdminTestHarness(backend([groupMapping], { body: { warning: 'NO_LOCAL_ADMIN' } }))
    renderControl(harness)
    await flush()

    const toggle = screen.getByRole('switch', { name: 'Make members of Ops admins' })
    expect(toggle).toBeChecked()
    fireEvent.click(toggle)
    await flush()

    expect(harness.requests.find((request) => request.method === 'DELETE')?.path).toBe('admin/role-mappings/m1')
    expect(screen.getByText('No admin can sign in without your identity provider')).toBeInTheDocument()
  })

  it('shows why a change was refused', async () => {
    const harness = createAdminTestHarness(({ method }) =>
      method === 'GET' ? { body: { items: [] } } : { status: 409, body: { code: 'MAPPING_EXISTS' } },
    )
    renderControl(harness)
    await flush()
    fireEvent.click(screen.getByRole('switch'))
    await flush()

    expect(screen.getByRole('alert')).toHaveTextContent('This group already has that role.')
  })
})
