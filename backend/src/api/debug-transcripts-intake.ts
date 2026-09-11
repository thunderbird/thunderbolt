/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Settings } from '@/config/settings'
import { createDebugTranscript, findDebugTranscriptClientByKeyHash, upsertSelfDebugTranscriptClient } from '@/dal'
import type { db as DbType } from '@/db/client'
import { debugTranscriptIntakeBodySchema, readBoundedJson } from '@/debug-transcripts/body'
import { hashDebugTranscriptClientKey, selfDebugTranscriptClientId } from '@/debug-transcripts/client-key'
import { safeErrorHandler } from '@/middleware/error-handling'
import type { RateLimitConsumer } from '@/middleware/rate-limit'
import {
  debugTranscriptIntakePath,
  debugTranscriptMaxRequestBytes,
  debugTranscriptServerPayloadMaxBytes,
  debugTranscriptTooLargeCode,
} from '@shared/debug-transcript-contract'
import { Elysia } from 'elysia'

type IntakeRoutesOptions = {
  database: typeof DbType
  settings: Pick<Settings, 'debugTranscriptIntakeEnabled'>
  rateLimit: RateLimitConsumer | null
}

type IntakeSettings = Pick<Settings, 'debugTranscriptIntakeEnabled' | 'debugTranscriptUpstreamKey'>

/** Read the server-to-server client credential. */
const bearerKey = (request: Request): string | null => {
  const header = request.headers.get('authorization')
  return header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() || null : null
}

/**
 * Intake role: accept transcripts from registered clients (deployments) and
 * store them. Authenticated by a per-client key, never by a user session.
 */
export const createDebugTranscriptsIntakeRoutes = ({ database, settings, rateLimit }: IntakeRoutesOptions) => {
  if (!settings.debugTranscriptIntakeEnabled) {
    return new Elysia()
  }
  return new Elysia({ normalize: false }).onError(safeErrorHandler).post(
    `/${debugTranscriptIntakePath}`,
    async ({ request, set }) => {
      const key = bearerKey(request)
      const client = key ? await findDebugTranscriptClientByKeyHash(database, hashDebugTranscriptClientKey(key)) : null
      if (!client) {
        set.status = 401
        return { error: 'Unknown debug transcript client' }
      }
      if (client.revokedAt) {
        set.status = 403
        return { error: 'Debug transcript client revoked' }
      }
      const limited = await rateLimit?.(`client:${client.id}`, set)
      if (limited) {
        return limited
      }

      const read = await readBoundedJson(request, debugTranscriptMaxRequestBytes)
      if (!read.ok && read.reason === 'too_large') {
        set.status = 413
        return { error: 'Debug transcript request exceeds maximum size', code: debugTranscriptTooLargeCode }
      }
      const parsed = read.ok ? debugTranscriptIntakeBodySchema.safeParse(read.value) : null
      if (!parsed?.success) {
        set.status = 422
        return { error: 'Invalid debug transcript' }
      }

      if (Buffer.byteLength(JSON.stringify(parsed.data.payload), 'utf8') > debugTranscriptServerPayloadMaxBytes) {
        set.status = 413
        return { error: 'Debug transcript payload exceeds 2 MB', code: debugTranscriptTooLargeCode }
      }

      const id = crypto.randomUUID()
      await createDebugTranscript(database, {
        id,
        clientId: client.id,
        userId: parsed.data.userId,
        localUserId: client.id === selfDebugTranscriptClientId ? parsed.data.userId : null,
        threadId: parsed.data.threadId,
        schemaVersion: parsed.data.schemaVersion,
        payload: parsed.data.payload,
        userNote: parsed.data.userNote,
        clientVersion: parsed.data.clientVersion,
      })
      set.status = 201
      return { id }
    },
    { parse: 'none' },
  )
}

/** Startup: the intake host is a client of itself; keep its row in sync with the configured key. */
export const ensureSelfDebugTranscriptClient = async (
  database: typeof DbType,
  settings: IntakeSettings,
): Promise<void> => {
  if (!settings.debugTranscriptIntakeEnabled || !settings.debugTranscriptUpstreamKey) {
    return
  }
  await upsertSelfDebugTranscriptClient(database, hashDebugTranscriptClientKey(settings.debugTranscriptUpstreamKey))
}
