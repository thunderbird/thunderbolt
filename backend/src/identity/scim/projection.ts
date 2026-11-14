/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { queueAfterTransactionHook, tryGetCurrentAuthEndpointContext } from '@better-auth/core/context'
import type { SCIMProjection, SCIMTransactionContext } from '@better-auth/scim'
import { createAuditEvent } from '../audit/write'
import { getCurrentOrganizationId } from '../current-organization'
import { getScimActor, scimAuditEvent } from './actor'
import { currentGroupWrite, getScimRequestScope } from './request-scope'

/** The transactions whose group change is already written: the plugin calls the projection once per member. */
const recordedInTransaction = new WeakSet<object>()

/**
 * Record the current request's group change, once, from inside its transaction. The plugin calls
 * the projection for each member the change touches, so this runs only when the group has members;
 * the pipeline records a change to a group without any after the commit.
 */
const recordGroupChange = async ({ database }: SCIMTransactionContext) => {
  const scope = getScimRequestScope()
  const change = currentGroupWrite()
  if (!scope || scope.groupEventsRecorded || !change || recordedInTransaction.has(database)) {
    return
  }
  recordedInTransaction.add(database)
  const actor = await getScimActor(database)
  if (!actor) {
    return
  }
  // A create has no id in its route; the new group is visible in the transaction.
  const displayName = (tryGetCurrentAuthEndpointContext()?.body as { displayName?: unknown } | undefined)?.displayName
  const created =
    change.groupId === null && typeof displayName === 'string'
      ? await database.findOne<{ id: string }>({
          model: 'scimGroup',
          where: [
            { field: 'connectionId', value: actor.scimConnectionId },
            { field: 'displayName', value: displayName },
          ],
        })
      : null
  for (const action of change.actions) {
    await createAuditEvent(
      database,
      scimAuditEvent(action, {
        ...actor,
        target: { type: 'scim_group', id: change.groupId ?? created?.id ?? null },
      }),
    )
  }
  // Only once the events commit: an attempt the plugin or the pipeline retries rolls them back.
  await queueAfterTransactionHook(async () => {
    scope.groupEventsRecorded = true
  })
}

/**
 * The plugin's role projection: a SCIM group grants the roles `group_role_mapping` maps to its id.
 * Keyed on the group's stable id and never its name, so renaming a group to "Admins" grants
 * nothing. The plugin stores the result in `scimProjectionGrant`, which `roles.ts` reads, and drops
 * it while the member's SCIM user is inactive or deleted.
 */
export const scimProjection: SCIMProjection = {
  roles: {
    map: async ({ connectionId, source }, { database }) => {
      const orgId = getCurrentOrganizationId()
      const connection = await database.findOne<{ id: string }>({
        model: 'identityConnection',
        where: [
          { field: 'orgId', value: orgId },
          { field: 'scimConnectionId', value: connectionId },
        ],
      })
      if (!connection) {
        return []
      }
      const mappings = await database.findMany<{ role: string }>({
        model: 'groupRoleMapping',
        where: [
          { field: 'orgId', value: orgId },
          { field: 'identityConnectionId', value: connection.id },
          { field: 'scimGroupId', value: source.id },
        ],
      })
      return mappings.map((mapping) => mapping.role)
    },
    // The mappings are the role catalog: a role exists once a mapping names it.
    exists: async () => true,
  },
  // The plugin writes the grants itself; what is left is the audit event of a group change.
  reconcileUser: (_state, context) => recordGroupChange(context),
}
