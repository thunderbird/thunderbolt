/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Settings } from '@/config/settings'
import { extractClientIp } from '@/utils/request'
import { Elysia, InvertedStatusMap } from 'elysia'
import type { Logger } from 'pino'

/** What Elysia's compiled request handler actually returns; its `HigherOrderFunction` type says `Function`. */
type RequestHandler = (request: Request) => Response | Promise<Response>

/** Health/static and most PostHog endpoints (except config) are too noisy to access-log. */
const isExcluded = (pathname: string) =>
  pathname === '/v1/health' ||
  pathname.startsWith('/static/') ||
  (pathname.startsWith('/v1/posthog/') && pathname !== '/v1/posthog/config')

/**
 * HTTP request/response logging middleware
 * Logs requests in Apache Common Log format with response time
 *
 * Wraps the whole request handler (`.wrap`, which Elysia hoists to the root app on `.use`)
 * instead of using a lifecycle hook, because no hook sees every response: `onAfterHandle`
 * misses 404s and thrown errors, `onAfterResponse` misses `onRequest` short-circuits (the
 * app-version 426) and, once any plugin registers an `onError`, 404s, and both skip routes
 * registered before this plugin (the CORS preflight).
 * A WebSocket upgrade logs as 200: Elysia still maps a Response, which Bun discards after upgrading.
 * Elysia marks `.wrap` private, so `http-logging.test.ts`, including its listening-server case, is the upgrade guard.
 */
export const createHttpLoggingMiddleware = (
  logger: Pick<Logger, 'info'>,
  trustedProxy: Settings['trustedProxy'] = '',
) =>
  new Elysia({ name: 'http-logging' }).wrap((fn) => {
    const handle = fn as unknown as RequestHandler
    return async (request: Request) => {
      const startedAt = Date.now()
      const response = await handle(request)
      const { pathname } = new URL(request.url)
      if (isExcluded(pathname)) {
        return response
      }

      const statusText = (InvertedStatusMap as Record<number, string>)[response.status]
      const client = extractClientIp(request.headers, '-', trustedProxy)

      logger.info(
        `${client} - "${request.method} ${pathname} HTTP/1.1" ${response.status}${statusText ? ` ${statusText}` : ''} ${Date.now() - startedAt}ms`,
      )
      return response
    }
  })
