/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { tryGetCurrentAuthEndpointContext } from '@better-auth/core/context'
import type { BetterAuthPlugin } from 'better-auth'
import { createAuthMiddleware } from 'better-auth/api'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { AuditAction } from '../audit/events'
import { getScimActor, type ScimActor } from './actor'

/*
 * What the pipeline learns about one SCIM request from inside the plugin: the connection it
 * authenticated as, and the group change it made, so that work done after the plugin answered
 * (recording a refusal, or the event of a group with no members) is attributed and never doubled.
 */

/** A change to one SCIM group, as its audit actions. */
export type GroupChange = { groupId: string | null; actions: AuditAction[] }

type ScimRequestScope = {
  actor: ScimActor | null
  /** Set by the after-hook on a successful group change. */
  groupChange: GroupChange | null
  /** Set once the change's events were written in the plugin's transaction. */
  groupEventsRecorded: boolean
}

const scopeStorage = new AsyncLocalStorage<ScimRequestScope>()

/** Run one SCIM request with a fresh scope; returns the result and what the scope learned. */
export const withScimRequestScope = <T>(callback: () => Promise<T>) => {
  const scope: ScimRequestScope = { actor: null, groupChange: null, groupEventsRecorded: false }
  return scopeStorage.run(scope, async () => ({ result: await callback(), scope }))
}

/** The current request's scope, or undefined outside the pipeline (server-side `auth.api` calls). */
export const getScimRequestScope = () => scopeStorage.getStore()

type EndpointView = { path?: string; method?: string; params?: { groupId?: string }; body?: unknown }

type PatchOperation = { op?: unknown; path?: unknown; value?: unknown }

/** Whether a PATCH operation touches group membership: a `members` path, or a pathless value carrying them. */
const touchesMembers = ({ path, value }: PatchOperation) =>
  typeof path === 'string'
    ? path === 'members' || path.startsWith('members[')
    : typeof value === 'object' && value !== null && 'members' in value

/**
 * The audit actions of a group write, from the endpoint and its body: create, delete, a full
 * replace (an update), or a PATCH that changes the group, its members, or both.
 */
export const describeGroupWrite = ({ path, method, params, body }: EndpointView): GroupChange | null => {
  if (!path?.startsWith('/scim/v2/Groups')) {
    return null
  }
  const groupId = params?.groupId ?? null
  if (method === 'POST') {
    return { groupId, actions: ['scim.group_created'] }
  }
  if (method === 'DELETE') {
    return { groupId, actions: ['scim.group_deleted'] }
  }
  if (method === 'PUT') {
    return { groupId, actions: ['scim.group_updated'] }
  }
  if (method !== 'PATCH') {
    return null
  }
  const operations = ((body as { Operations?: unknown } | undefined)?.Operations ?? []) as PatchOperation[]
  const actions: AuditAction[] = []
  if (operations.some((operation) => !touchesMembers(operation))) {
    actions.push('scim.group_updated')
  }
  if (operations.some(touchesMembers)) {
    actions.push('scim.group_members_changed')
  }
  return actions.length > 0 ? { groupId, actions } : null
}

/** The group write of the current endpoint, read off its context. */
export const currentGroupWrite = () => {
  const endpoint = tryGetCurrentAuthEndpointContext()
  return endpoint ? describeGroupWrite(endpoint as EndpointView) : null
}

/**
 * After each SCIM endpoint, failed ones included: copy the authenticated actor into the scope,
 * and, for a successful group write, the change with the group's id.
 */
export const scimRequestScope = () =>
  ({
    id: 'scim-request-scope',
    hooks: {
      after: [
        {
          matcher: (ctx) => ctx.path?.startsWith('/scim/v2/') ?? false,
          handler: createAuthMiddleware(async (ctx) => {
            const scope = scopeStorage.getStore()
            if (!scope) {
              return
            }
            scope.actor = (await getScimActor(ctx.context.adapter)) ?? scope.actor
            const returned = ctx.context.returned
            if (returned instanceof Error) {
              return
            }
            const change = describeGroupWrite(ctx as EndpointView)
            if (change) {
              const id = (returned as { id?: unknown } | undefined)?.id
              scope.groupChange = { ...change, groupId: change.groupId ?? (typeof id === 'string' ? id : null) }
            }
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin
