/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Elysia } from 'elysia'
import { pino, type Logger } from 'pino'
import type { Settings } from './settings'

/**
 * Map our log levels to Pino's log levels
 */
const getLogLevel = (level: Settings['logLevel']): 'debug' | 'info' | 'warn' | 'error' => {
  switch (level) {
    case 'DEBUG':
      return 'debug'
    case 'INFO':
      return 'info'
    case 'WARN':
      return 'warn'
    case 'ERROR':
      return 'error'
    default:
      return 'info'
  }
}

/**
 * Create a Pino logger instance.
 *
 * The universal proxy is designed so caller-controlled URLs, bodies, and
 * credentials never reach a log line: the proxy module logs only the upstream
 * hostname (see `proxy/observability.ts`) and the standard Elysia request
 * logger never receives proxy passthrough headers. We therefore rely on Pino's
 * default behaviour rather than bolting on a bespoke redact list.
 */
const createStandaloneLogger = (settings: Settings): Logger => {
  const isDevelopment = process.env.NODE_ENV !== 'production'
  const level = getLogLevel(settings.logLevel)

  if (isDevelopment) {
    return pino({
      level,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: false,
          ignore: 'pid,hostname,time',
        },
      },
    })
  }

  return pino({ level })
}

/**
 * Minimal logger middleware: only decorates ctx.log with pino
 */
const createLoggerMiddleware = (settings: Settings) => {
  const logger = createStandaloneLogger(settings)
  return new Elysia({ name: 'logger' }).decorate('log', logger)
}

export { createLoggerMiddleware, createStandaloneLogger }
