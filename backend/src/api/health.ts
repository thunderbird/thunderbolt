/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { timingSafeEqual } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { sql } from 'drizzle-orm'
import { Elysia } from 'elysia'
import { z } from 'zod'
import type { Settings } from '@/config/settings'
import type { db } from '@/db/client'
import type { InferenceDatabase } from '@/inference/usage-ledger'
import { probeCatalogModels, type ModelProbeDeps } from '@/inference/model-probe'
import { emailFrom } from '@/lib/resend'
import { safeErrorHandler } from '@/middleware/error-handling'

const databaseTimeoutMs = 5_000
const powersyncTimeoutMs = 5_000
const emailTimeoutMs = 10_000
const resendDomainsSchema = z.object({ data: z.array(z.object({ name: z.string(), status: z.string() })) })

export type HealthRouteDeps = {
  settings: Pick<
    Settings,
    'monitoringToken' | 'powersyncUrl' | 'resendMonitoringApiKey' | 'anthropicApiKey' | 'tinfoilApiKey'
  >
  database: Pick<typeof db, 'execute'> & InferenceDatabase
  fetchFn?: typeof fetch
  probeModels?: typeof probeCatalogModels
  confidentialTransport?: ModelProbeDeps['confidentialTransport']
  logger?: ModelProbeDeps['logger']
  timeouts?: Partial<Record<'database' | 'powersync' | 'email', number>>
}

/** Creates token-protected deep health routes for backend dependencies. */
export const createHealthRoutes = ({
  settings,
  database,
  fetchFn = globalThis.fetch,
  probeModels = probeCatalogModels,
  confidentialTransport,
  logger,
  timeouts = {},
}: HealthRouteDeps) =>
  new Elysia({ prefix: '/health' })
    .onError(safeErrorHandler)
    .onBeforeHandle(({ request, status }) => {
      if (!settings.monitoringToken) {
        return status(403, { error: 'Monitoring token not configured' })
      }
      const expected = Buffer.from(`Bearer ${settings.monitoringToken}`)
      const actual = Buffer.from(request.headers.get('Authorization') ?? '')
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        return status(401, { error: 'Unauthorized' })
      }
    })
    .get('/database', async ({ status }) => {
      const deadline = new AbortController()
      try {
        const result = await Promise.race([
          database.execute(sql`select 1`),
          delay(timeouts.database ?? databaseTimeoutMs, 'timeout' as const, { signal: deadline.signal }),
        ])
        if (result === 'timeout') {
          return status(503, { status: 'failed', reason: 'timeout' })
        }
        return { status: 'ok' }
      } catch (error) {
        return status(503, {
          status: 'failed',
          reason: error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'unreachable',
        })
      } finally {
        deadline.abort()
      }
    })
    .get('/powersync', async ({ status }) => {
      if (!settings.powersyncUrl) {
        return status(503, { status: 'failed', reason: 'not-configured' })
      }
      try {
        const response = await fetchFn(`${settings.powersyncUrl.replace(/\/$/, '')}/probes/liveness`, {
          signal: AbortSignal.timeout(timeouts.powersync ?? powersyncTimeoutMs),
        })
        if (!response.ok) {
          return status(503, { status: 'failed', reason: `http-${response.status}` })
        }
        return { status: 'ok' }
      } catch (error) {
        return status(503, {
          status: 'failed',
          reason: error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'unreachable',
        })
      }
    })
    .get('/email', async ({ status }) => {
      if (!settings.resendMonitoringApiKey) {
        return status(503, { status: 'failed', reason: 'not-configured' })
      }
      try {
        const response = await fetchFn('https://api.resend.com/domains', {
          headers: { Authorization: `Bearer ${settings.resendMonitoringApiKey}` },
          signal: AbortSignal.timeout(timeouts.email ?? emailTimeoutMs),
        })
        if (response.status === 400 || response.status === 401 || response.status === 403) {
          return status(503, { status: 'failed', reason: 'rejected' })
        }
        if (!response.ok) {
          return status(503, { status: 'failed', reason: `http-${response.status}` })
        }
        // Malformed bodies cannot establish domain verification; invalid JSON is handled below.
        const domains = resendDomainsSchema.safeParse(await response.json())
        if (
          !domains.success ||
          !domains.data.data.some(({ name, status }) => name === emailFrom.split('@')[1] && status === 'verified')
        ) {
          return status(503, { status: 'failed', reason: 'domain-unverified' })
        }
        return { status: 'ok' }
      } catch (error) {
        if (error instanceof SyntaxError) {
          return status(503, { status: 'failed', reason: 'domain-unverified' })
        }
        return status(503, {
          status: 'failed',
          reason: error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'unreachable',
        })
      }
    })
    .get('/models', async ({ status }) => {
      const failures = await probeModels({ database, settings, fetchFn, confidentialTransport, logger })
      if (failures.length) {
        return status(503, { status: 'failed', failures })
      }
      return { status: 'ok' }
    })
