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
 * Redact paths applied to every log entry to prevent PII / secrets leakage.
 *
 * Covers:
 *   - Authorization headers (incl. our own X-Upstream-Authorization)
 *   - Cookie / Set-Cookie
 *   - Mcp-Session-Id (session identifier from MCP sessions)
 *   - `req.url` — the proxy encodes the full target URL into the path, which
 *     can contain auth-bearing query parameters.
 *   - `email` — Better Auth and other code paths may attach user email.
 *   - Common body / response body fields that proxies could surface accidentally.
 *
 * Pino's redact uses fast-redact path syntax: dot-paths with bracket-quoted segments
 * for keys with non-identifier characters. Header names are case-preserved by
 * fetch implementations, so we list both lowercased (Bun) and Title-Cased
 * (some other runtimes) variants where ambiguity exists.
 */
export const redactPaths = [
  'req.headers.authorization',
  'req.headers.Authorization',
  'req.headers.cookie',
  'req.headers.Cookie',
  'req.headers["x-upstream-authorization"]',
  'req.headers["X-Upstream-Authorization"]',
  'req.headers["mcp-session-id"]',
  'req.headers["Mcp-Session-Id"]',
  'req.url',
  'res.headers["set-cookie"]',
  'res.headers["Set-Cookie"]',
  'headers.authorization',
  'headers.cookie',
  'headers["x-upstream-authorization"]',
  'headers["mcp-session-id"]',
  'headers["set-cookie"]',
  'email',
  'user.email',
  'body',
  'requestBody',
  'responseBody',
]

/**
 * Create a Pino logger instance
 */
const createPinoLogger = (settings: Settings): Logger => {
  const isDevelopment = process.env.NODE_ENV !== 'production'
  const level = getLogLevel(settings.logLevel)

  const redact = {
    paths: redactPaths,
    censor: '[REDACTED]',
    remove: false,
  }

  if (isDevelopment) {
    // Development: Pretty printed logs with colors
    return pino({
      level,
      redact,
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

  // Production: JSON structured logs
  return pino({
    level,
    redact,
  })
}

/**
 * Minimal logger middleware: only decorates ctx.log with pino
 */
const createLoggerMiddleware = (settings: Settings) => {
  const logger = createPinoLogger(settings)
  return new Elysia({ name: 'logger' }).decorate('log', logger)
}

/**
 * Create a standalone logger instance for use outside request contexts
 */
const createStandaloneLogger = (settings: Settings): Logger => {
  return createPinoLogger(settings)
}

export { createLoggerMiddleware, createPinoLogger, createStandaloneLogger }
