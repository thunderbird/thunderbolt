/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import type { AdminMember, LocalGroup, LocalGroupMember } from '@shared/admin-api'
import type { FakeReply, FakeRequest } from '../../test-utils'
import { makeMember } from '../members/member-fixtures'

export const ops: LocalGroup = {
  id: 'g1',
  name: 'Ops',
  description: null,
  memberCount: 1,
  roles: [],
  createdAt: '2026-11-01T00:00:00.000Z',
}

export const ada: LocalGroupMember = {
  userId: 'user-1',
  email: 'ada@example.com',
  name: 'Ada Lovelace',
  addedAt: '2026-11-02T00:00:00.000Z',
}

export const bob = makeMember({ userId: 'user-2', email: 'bob@example.com', name: 'Bob' })

/**
 * A backend with the group `ops` holding Ada, members Ada and Bob, and no role mappings. A created
 * group is served back as `g-new`. Removals answer with `removeReply`. With `self`, the signed-in
 * admin is in `ops` too, and their detail is `self`.
 */
export const groupBackend = (removeReply: FakeReply = { body: {} }, self?: AdminMember) => {
  let created: LocalGroup | null = null
  return ({ method, path, body }: FakeRequest): FakeReply => {
    if (method === 'DELETE') {
      return removeReply
    }
    if (method === 'POST' && path === 'admin/groups') {
      created = { ...ops, id: 'g-new', ...(body as object), memberCount: 0 }
      return { body: created }
    }
    if (created && path.startsWith('admin/groups/g-new')) {
      return path.endsWith('/members') ? { body: { items: [], nextCursor: null } } : { body: created }
    }
    if (method === 'POST' && path.endsWith('/members')) {
      return { status: 204 }
    }
    if (method === 'PATCH') {
      return { body: { ...ops, ...(body as object) } }
    }
    if (path === 'admin/link-reviews') {
      return { body: { reviews: [], nextCursor: null } }
    }
    if (path === 'admin/role-mappings') {
      return { body: { items: [] } }
    }
    if (path === 'admin/members') {
      return { body: { items: [makeMember(), bob], nextCursor: null } }
    }
    if (self && path === `admin/members/${self.userId}`) {
      return { body: self }
    }
    if (path === 'admin/groups/g1/members') {
      const selfInGroup = self && { ...ada, userId: self.userId, email: self.email, name: self.name }
      return { body: { items: selfInGroup ? [ada, selfInGroup] : [ada], nextCursor: null } }
    }
    if (path === 'admin/groups') {
      return { body: { items: [ops], nextCursor: null } }
    }
    return { body: ops }
  }
}
