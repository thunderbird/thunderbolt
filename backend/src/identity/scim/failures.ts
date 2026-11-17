/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { db as DbType } from '@/db/client'
import { recordFailedAttempt } from '../audit/write'
import type { ScimActor } from './actor'

/*
 * Failed or incomplete provisioning, made visible per connection: each SCIM request the backend
 * rejects, once it knows which connection sent it, leaves a failed `scim.request` audit event.
 * Requests that never authenticated (401) can't be attributed, and rate-limit refusals are not
 * recorded, so a flood writes nothing.
 */

const resourcePath = /\/scim\/v2\/([^/?]+)(?:\/([^/?]+))?/

const resourceTargetTypes: Record<string, string> = { Users: 'scim_user', Groups: 'scim_group' }

/** The SCIM error fields of a refusal, when it is in SCIM's error format. */
const readScimError = async (response: Response) => {
  try {
    const body = (await response.clone().json()) as { scimType?: unknown; detail?: unknown }
    return {
      scimType: typeof body.scimType === 'string' ? body.scimType : null,
      detail: typeof body.detail === 'string' ? body.detail.slice(0, 500) : null,
    }
  } catch {
    return { scimType: null, detail: null }
  }
}

/**
 * Record a rejected SCIM request against the connection it authenticated as. Runs after the
 * plugin's transaction ended, so the event survives its rollback. Never stores the body: only the
 * method, the resource and the plugin's own error text.
 */
export const recordRejectedScimRequest = async (
  database: typeof DbType,
  { request, response, actor }: { request: Request; response: Response; actor: ScimActor },
) => {
  const [, resourceType = null, resourceId = null] = resourcePath.exec(new URL(request.url).pathname) ?? []
  const targetType = resourceType ? resourceTargetTypes[resourceType] : undefined
  const { scimType, detail } = await readScimError(response)
  await recordFailedAttempt(database, {
    action: 'scim.request',
    outcome: 'failure',
    reason: scimType ?? String(response.status),
    actor: { type: 'scim_connection', id: actor.identityConnectionId },
    target: targetType ? { type: targetType, id: resourceId } : undefined,
    connectionId: actor.identityConnectionId,
    credentialId: actor.credentialId,
    metadata: { method: request.method, resourceType, resourceId, status: response.status, scimType, detail },
  })
}
