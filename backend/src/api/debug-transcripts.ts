/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from '@/auth/elysia-plugin'
import { createAuthMacro } from '@/auth/elysia-plugin'
import type { Settings } from '@/config/settings'
import { createDebugTranscript } from '@/dal'
import type { db as DbType } from '@/db/client'
import { safeErrorHandler } from '@/middleware/error-handling'
import {
  anonymousTranscriptForbiddenCode,
  debugTranscriptNoteMaxLength,
  debugTranscriptServerPayloadMaxBytes,
  debugTranscriptsDisabledCode,
  debugTranscriptTooLargeCode,
} from '@shared/debug-transcript-contract'
import { Elysia, type AnyElysia, t } from 'elysia'

// Reserve space for the bounded metadata fields around the 2 MB payload.
const maxDebugTranscriptRequestBytes = debugTranscriptServerPayloadMaxBytes + 4 * 1024
const debugTranscriptPathPattern = /\/debug-transcripts\/?$/

type DebugTranscriptsRoutesOptions = {
  auth: Auth
  database: typeof DbType
  settings: Pick<Settings, 'debugTranscriptsEnabled'>
  rateLimit?: AnyElysia
}

/** Create authenticated debug transcript upload routes. */
export const createDebugTranscriptsRoutes = ({
  auth,
  database,
  settings,
  rateLimit,
}: DebugTranscriptsRoutesOptions) => {
  if (!settings.debugTranscriptsEnabled) {
    return new Elysia({ normalize: false }).group('/debug-transcripts', (routes) =>
      routes.post('/', ({ set }) => {
        set.status = 403
        return {
          error: 'Debug transcript uploads are disabled',
          code: debugTranscriptsDisabledCode,
        }
      }),
    )
  }

  const requestGate = new Elysia().onRequest(({ request, set }) => {
    // Elysia hoists plugin request hooks into the parent. Keep this pre-parse
    // size check path-scoped so unrelated routes are unaffected.
    if (!debugTranscriptPathPattern.test(new URL(request.url).pathname)) {
      return
    }

    const contentLength = request.headers.get('content-length')
    if (
      contentLength &&
      Number.isFinite(Number(contentLength)) &&
      Number(contentLength) > maxDebugTranscriptRequestBytes
    ) {
      set.status = 413
      return {
        error: 'Debug transcript request exceeds maximum size',
        code: debugTranscriptTooLargeCode,
      }
    }
  })

  const app = new Elysia({ normalize: false }).onError(safeErrorHandler).use(createAuthMacro(auth))

  return app.group('/debug-transcripts', (routes) =>
    routes.guard({ auth: true }, (guardedApp) => {
      guardedApp.use(requestGate)

      if (rateLimit) {
        guardedApp.use(rateLimit)
      }

      return guardedApp.post(
        '/',
        async ({ body, set, user }) => {
          if (user.isAnonymous) {
            set.status = 403
            return { error: 'Forbidden', code: anonymousTranscriptForbiddenCode }
          }

          if (Buffer.byteLength(JSON.stringify(body.payload), 'utf8') > debugTranscriptServerPayloadMaxBytes) {
            set.status = 413
            return {
              error: 'Debug transcript payload exceeds 2 MB',
              code: debugTranscriptTooLargeCode,
            }
          }

          const id = crypto.randomUUID()
          await createDebugTranscript(database, {
            id,
            userId: user.id,
            threadId: body.threadId,
            schemaVersion: body.schemaVersion,
            payload: body.payload,
            userNote: body.userNote,
            clientVersion: body.clientVersion,
          })

          set.status = 201
          return { id }
        },
        {
          body: t.Object({
            threadId: t.String({
              minLength: 1,
              maxLength: 100,
              pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$',
            }),
            schemaVersion: t.Integer({ minimum: 1, maximum: 1000 }),
            payload: t.Object({}, { additionalProperties: true }),
            userNote: t.Optional(t.String({ maxLength: debugTranscriptNoteMaxLength })),
            clientVersion: t.Optional(t.String({ maxLength: 100 })),
          }),
        },
      )
    }),
  )
}
