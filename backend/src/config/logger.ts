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
 * Pino redact paths covering the universal proxy's PII surface area.
 * Caller-controlled URLs, bodies, and credentials must never reach a log line.
 */
const proxyRedactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-proxy-target-url"]',
  'res.headers["set-cookie"]',
  'targetUrl',
  'target_url',
  'body',
  'requestBody',
  'responseBody',
]

/** Drop any X-Proxy-Passthrough-* header before logging — Pino redact can't
 *  pattern-match keys, so we strip via a serialiser. */
const dropPassthroughHeaders = (headers: Record<string, unknown> | undefined) => {
  if (!headers) return headers
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(headers)) {
    if (/^x-proxy-passthrough-/i.test(k)) continue
    out[k] = v
  }
  return out
}

/**
 * Create a Pino logger instance
 */
const createPinoLogger = (settings: Settings): Logger => {
  const isDevelopment = process.env.NODE_ENV !== 'production'
  const level = getLogLevel(settings.logLevel)

  const baseOptions = {
    level,
    redact: { paths: proxyRedactPaths, censor: '[REDACTED]' },
    serializers: {
      req: (req: { headers?: Record<string, unknown>; [k: string]: unknown }) => ({
        ...req,
        headers: dropPassthroughHeaders(req.headers),
      }),
    },
  }

  if (isDevelopment) {
    // Development: Pretty printed logs with colors
    return pino({
      ...baseOptions,
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
  return pino(baseOptions)
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

let standaloneLogger: Logger | null = null

/** Lazy singleton accessor for code that runs outside request middleware. */
const getStandaloneLogger = (): Logger => {
  if (!standaloneLogger) {
    // Lazy import settings to avoid circular init at module top.
    const { getSettings } = require('./settings')
    standaloneLogger = createPinoLogger(getSettings())
  }
  return standaloneLogger
}

export { createLoggerMiddleware, createPinoLogger, createStandaloneLogger, getStandaloneLogger }
