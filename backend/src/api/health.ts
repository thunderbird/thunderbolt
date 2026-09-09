/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { timingSafeEqual } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { sql } from 'drizzle-orm'
import { Elysia } from 'elysia'
import type { Settings } from '@/config/settings'
import type { db } from '@/db/client'
import type { InferenceDatabase } from '@/inference/usage-ledger'
import { probeCatalogModels } from '@/inference/model-probe'
import { safeErrorHandler } from '@/middleware/error-handling'

const databaseTimeoutMs = 5_000
const powersyncTimeoutMs = 5_000
const emailTimeoutMs = 10_000

export type HealthRouteDeps = {
  settings: Pick<
    Settings,
    'monitoringToken' | 'powersyncUrl' | 'resendApiKey' | 'anthropicApiKey' | 'tinfoilApiKey' | 'tinfoilEnclaveUrl'
  >
  database: Pick<typeof db, 'execute'> & InferenceDatabase
  fetchFn?: typeof fetch
  probeModels?: typeof probeCatalogModels
  confidentialFetch?: typeof fetch
}

/** Creates token-protected deep health routes for backend dependencies. */
export const createHealthRoutes = ({
  settings,
  database,
  fetchFn = globalThis.fetch,
  probeModels = probeCatalogModels,
  confidentialFetch,
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
          delay(databaseTimeoutMs, 'timeout' as const, { signal: deadline.signal }),
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
          signal: AbortSignal.timeout(powersyncTimeoutMs),
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
      if (!settings.resendApiKey) {
        return status(503, { status: 'failed', reason: 'not-configured' })
      }
      try {
        const response = await fetchFn('https://api.resend.com/domains', {
          headers: { Authorization: `Bearer ${settings.resendApiKey}` },
          signal: AbortSignal.timeout(emailTimeoutMs),
        })
        if (response.status === 401 || response.status === 403) {
          return status(503, { status: 'failed', reason: 'rejected' })
        }
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
    .get('/models', async ({ status }) => {
      const failures = await probeModels({ database, settings, fetchFn, confidentialFetch })
      if (failures.length) {
        return status(503, { status: 'failed', failures })
      }
      return { status: 'ok' }
    })
