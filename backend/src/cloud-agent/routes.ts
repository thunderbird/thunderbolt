/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Elysia } from 'elysia'
import { z } from 'zod'
import { createAuthMacro, type Auth } from '@/auth/elysia-plugin'
import { ArtifactServiceError, type ArtifactService } from './artifacts'
import { testConnection } from './connections'
import { CloudError } from './errors'
import { requireCloudTrustedDevice } from './device'
import {
  envelopeSchema,
  epoch,
  identifier,
  identitySchema,
  revisionSchema,
  saveResourceSchema,
  scheduleSchema,
  submitSchema,
} from './input'
import type { CloudAgentService } from './service'

/** Authenticated commands and projections share the existing API process. */
export const createCloudAgentRoutes = (auth: Auth, service: CloudAgentService, artifacts: ArtifactService | null) => {
  const artifactService = () => {
    if (!artifacts) {
      throw new CloudError(503, 'artifact_storage_unavailable')
    }
    return artifacts
  }
  const sameId = (pathId: string, bodyId: string) => {
    if (pathId !== bodyId) {
      throw new CloudError(422, 'resource_id_mismatch')
    }
  }
  return new Elysia({ name: 'cloud-agents', prefix: '/cloud-agents' })
    .onError(({ code, error, set }) => {
      if (error instanceof CloudError) {
        set.status = error.status
        return { error: error.code }
      }
      if (error instanceof ArtifactServiceError) {
        set.status = error.status
        return { error: error.code }
      }
      if (code === 'PARSE' || code === 'VALIDATION' || error instanceof z.ZodError || error instanceof SyntaxError) {
        set.status = 422
        return { error: 'invalid_cloud_request' }
      }
      set.status = 500
      // Errors may contain decrypted provider content; never log their message or stack here.
      console.error('Cloud agent request failed', { errorType: error instanceof Error ? error.name : 'unknown' })
      return { error: 'cloud_request_failed' }
    })
    .use(createAuthMacro(auth))
    .guard({ auth: true }, (app) =>
      app
        .onBeforeHandle(async ({ request, user, session }) => {
          if (user.isAnonymous) {
            throw new CloudError(403, 'cloud_account_required')
          }
          if (request.method !== 'GET' && request.method !== 'HEAD') {
            await requireCloudTrustedDevice(service.database, user.id, request, session)
          }
        })
        .get('/capabilities', ({ user }) => service.capabilities(user.id))
        .get('/identity', ({ user }) => service.identity(user.id))
        .post('/identity', ({ user, body }) => service.saveIdentity(user.id, identitySchema.parse(body)))
        .get('/agents', ({ user }) => service.agents(user.id))
        .get('/agents/:id', ({ user, params }) => service.agent(user.id, params.id))
        .post('/agents', ({ user, body }) => service.saveAgent(user.id, saveResourceSchema.parse(body)))
        .post('/agents/:id', ({ user, params, body }) => {
          const input = saveResourceSchema.parse(body)
          sameId(params.id, input.id)
          return service.saveAgent(user.id, input)
        })
        .get('/agents/:id/conversations', ({ user, params }) => service.conversations(user.id, params.id))
        .post('/agents/:id/conversations', ({ user, params, body }) => {
          const input = z.strictObject({ id: z.string().uuid().optional() }).parse(body ?? {})
          return service.createConversation(user.id, params.id, input.id)
        })
        .get('/conversations/:id', ({ user, params }) => service.state(user.id, params.id))
        .post('/conversations/:id/messages', ({ user, params, body }) =>
          service.submit(user.id, params.id, submitSchema.parse(body)),
        )
        .post('/conversations/:id/stop', ({ user, params }) => service.stop(user.id, params.id))
        .post('/approvals/:id/decide', ({ user, params, body }) =>
          service.decide(
            user.id,
            params.id,
            z.object({ decision: z.enum(['approved', 'denied']) }).parse(body).decision,
          ),
        )
        .get('/connections', ({ user }) => service.connections(user.id))
        .post('/connections', ({ user, body }) => service.saveConnection(user.id, saveResourceSchema.parse(body)))
        .post('/connections/:id', ({ user, params, body }) => {
          const input = saveResourceSchema.parse(body)
          sameId(params.id, input.id)
          return service.saveConnection(user.id, input)
        })
        .post('/connections/:id/test', ({ user, params }) => testConnection(service, user.id, params.id))
        .get('/agents/:id/schedules', ({ user, params }) => service.schedules(user.id, params.id))
        .post('/agents/:id/schedules/:scheduleId', ({ user, params, body }) => {
          const input = scheduleSchema.parse(body)
          sameId(params.scheduleId, input.id)
          sameId(params.id, input.agentId)
          return service.saveSchedule(user.id, input)
        })
        .get('/artifacts', async ({ user }) => ({ artifacts: await artifactService().list(user.id) }))
        .get('/artifacts/:id', ({ user, params }) => artifactService().get(user.id, params.id))
        .get('/artifacts/:id/revisions/:revisionId/content', ({ user, params }) =>
          artifactService().content(user.id, params.id, params.revisionId),
        )
        .post('/artifacts/:id/revisions', ({ user, params, body }) =>
          artifactService().publish(user.id, params.id, revisionSchema.parse(body)),
        )
        .get('/artifacts/:id/grants', async ({ user, params }) => ({
          grants: await artifactService().grants(user.id, params.id),
        }))
        .post('/artifacts/:id/grants', async ({ user, params, body }) => {
          await artifactService().grantAgent(
            user.id,
            params.id,
            z
              .object({ agentId: identifier, keyEpoch: epoch, keyEnvelope: envelopeSchema, canWrite: z.boolean() })
              .parse(body),
          )
          return { ok: true }
        })
        .post('/artifacts/:id/grants/:agentId/revoke', async ({ user, params }) => {
          await artifactService().revokeGrant(user.id, params.id, params.agentId)
          return { ok: true }
        }),
    )
}
