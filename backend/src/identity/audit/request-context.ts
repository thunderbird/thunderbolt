/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Elysia } from 'elysia'
import { AsyncLocalStorage } from 'node:async_hooks'

type RequestHandler = (request: Request) => Response | Promise<Response>

const requestIdStorage = new AsyncLocalStorage<string>()

/** Run `fn` as one request: every audit event it writes shares one request id. */
export const runWithAuditRequestId = <T>(fn: () => T, requestId: string = crypto.randomUUID()) =>
  requestIdStorage.run(requestId, fn)

/** The current request's id, or undefined outside a request (boot, background jobs). */
export const getAuditRequestId = () => requestIdStorage.getStore()

/**
 * Gives each request its own id, so the several events one request writes (a SCIM `DELETE`, say)
 * correlate. Server-generated: an inbound header is not trusted, and the id is not returned.
 * Wraps the whole handler, like `http-logging.ts`, so every route and hook runs inside it.
 */
export const createAuditRequestContext = () =>
  new Elysia({ name: 'audit-request-context' }).wrap((fn) => {
    const handle = fn as unknown as RequestHandler
    return (request: Request) => runWithAuditRequestId(() => handle(request))
  })
