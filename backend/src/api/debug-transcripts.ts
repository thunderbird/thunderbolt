/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from '@/auth/elysia-plugin'
import { createAuthMacro } from '@/auth/elysia-plugin'
import type { Settings } from '@/config/settings'
import { debugTranscriptSubmissionSchema, readBoundedJson } from '@/debug-transcripts/body'
import { safeErrorHandler } from '@/middleware/error-handling'
import {
  debugTranscriptIntakePath,
  debugTranscriptMaxRequestBytes,
  debugTranscriptServerPayloadMaxBytes,
  debugTranscriptsDisabledCode,
  debugTranscriptTooLargeCode,
  debugTranscriptUpstreamFailedCode,
} from '@shared/debug-transcript-contract'
import { Elysia, type AnyElysia } from 'elysia'
import { z } from 'zod'

const upstreamTimeoutMs = 10_000
const intakeResponseSchema = z.object({ id: z.string().min(1) })

type DebugTranscriptsRoutesOptions = {
  auth: Auth
  settings: Pick<Settings, 'debugTranscriptsEnabled' | 'debugTranscriptUpstreamUrl' | 'debugTranscriptUpstreamKey'>
  fetchFn: typeof fetch
  rateLimit?: AnyElysia
}

/** Forward a submission and validate the intake acknowledgment; upstream failures resolve to null. */
const forwardToIntake = async (
  settings: DebugTranscriptsRoutesOptions['settings'],
  fetchFn: typeof fetch,
  body: unknown,
): Promise<{ id: string } | null> => {
  try {
    const response = await fetchFn(
      `${settings.debugTranscriptUpstreamUrl.replace(/\/$/, '')}/v1/${debugTranscriptIntakePath}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.debugTranscriptUpstreamKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(upstreamTimeoutMs),
      },
    )
    if (response.status !== 201) {
      console.error('Debug transcript upstream failed', response.status)
      return null
    }
    const parsed = intakeResponseSchema.safeParse(await response.json())
    if (!parsed.success) {
      console.error('Debug transcript upstream returned an invalid acknowledgment')
      return null
    }
    return parsed.data
  } catch (error) {
    console.error('Debug transcript upstream fetch or response read failed', error)
    return null
  }
}

/**
 * Relay role: authenticate the user, validate, and forward to the intake.
 * Nothing is stored here, so a failed forward leaves no partial state and the app can retry.
 */
export const createDebugTranscriptsRoutes = ({ auth, settings, fetchFn, rateLimit }: DebugTranscriptsRoutesOptions) => {
  if (!settings.debugTranscriptsEnabled) {
    return new Elysia({ normalize: false }).group('/debug-transcripts', (routes) =>
      routes.post('/', ({ set }) => {
        set.status = 403
        return { error: 'Debug transcript uploads are disabled', code: debugTranscriptsDisabledCode }
      }),
    )
  }

  return new Elysia({ normalize: false })
    .onError(safeErrorHandler)
    .use(createAuthMacro(auth))
    .group('/debug-transcripts', (routes) =>
      routes.guard({ auth: true }, (guardedApp) => {
        if (rateLimit) {
          guardedApp.use(rateLimit)
        }
        return guardedApp.post(
          '/',
          async ({ request, set, user }) => {
            const read = await readBoundedJson(request, debugTranscriptMaxRequestBytes)
            if (!read.ok && read.reason === 'too_large') {
              set.status = 413
              return { error: 'Debug transcript request exceeds maximum size', code: debugTranscriptTooLargeCode }
            }
            const parsed = read.ok ? debugTranscriptSubmissionSchema.safeParse(read.value) : null
            if (!parsed?.success) {
              set.status = 422
              return { error: 'Invalid debug transcript' }
            }

            if (Buffer.byteLength(JSON.stringify(parsed.data.payload), 'utf8') > debugTranscriptServerPayloadMaxBytes) {
              set.status = 413
              return { error: 'Debug transcript payload exceeds 2 MB', code: debugTranscriptTooLargeCode }
            }

            const upstream = await forwardToIntake(settings, fetchFn, {
              ...parsed.data,
              userId: user.isAnonymous ? null : user.id,
            })
            if (!upstream) {
              set.status = 502
              return { error: 'Debug transcript upstream rejected the upload', code: debugTranscriptUpstreamFailedCode }
            }
            set.status = 201
            return upstream
          },
          { parse: 'none' },
        )
      }),
    )
}
