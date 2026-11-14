/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { authBasePath } from '@/auth/paths'
import type { db as DbType } from '@/db/client'
import {
  createFailureRateLimit,
  createRateLimitConsumer,
  type RateLimitSet,
  type RateLimitSettings,
  type RateLimitTierConfig,
} from '@/middleware/rate-limit'
import { createHash } from 'node:crypto'
import { createKeyedLock, type KeyedLock, sendRetryingConcurrentConflicts } from './concurrency'
import {
  guardExternalIdPatch,
  guardExternalIdPut,
  requireExternalId,
  rewriteEmailValueFilters,
  type ScimJson,
  type ScimPatchOperation,
  type ScimRefusal,
  stripUnsupportedExtensionOperations,
  stripUnsupportedExtensions,
} from './normalize'

/** Where SCIM is served: under Better Auth's mount, because the plugin builds `meta.location` from it. */
export const scimMountPath = `${authBasePath}/scim/v2`

export const isScimPath = (pathname: string) => pathname === scimMountPath || pathname.startsWith(`${scimMountPath}/`)

export type ScimRateLimits = {
  /** Keyed on the bearer token, so in practice one budget per connection. */
  perCredential: RateLimitTierConfig
  /** Keyed on the client IP; only rejected credentials spend it. */
  authFailuresPerIp: RateLimitTierConfig
}

/** A 25-user Keycloak full sync is about 225 requests. */
export const defaultScimRateLimits: ScimRateLimits = {
  perCredential: { max: 1200, durationSecs: 60 },
  authFailuresPerIp: { max: 20, durationSecs: 60 },
}

const scimErrorSchema = 'urn:ietf:params:scim:api:messages:2.0:Error'

/** A response in SCIM's error format (RFC 7644 §3.12). */
export const scimErrorResponse = (
  status: number,
  detail: string,
  scimType?: string,
  headers: RateLimitSet['headers'] = {},
) =>
  new Response(
    JSON.stringify({ schemas: [scimErrorSchema], status: String(status), detail, ...(scimType ? { scimType } : {}) }),
    {
      status,
      headers: {
        ...Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, String(value)])),
        'content-type': 'application/scim+json',
      },
    },
  )

const refusalResponse = (refusal: ScimRefusal) => scimErrorResponse(refusal.status, refusal.detail, refusal.scimType)

const resourcePath = /\/scim\/v2\/(Users|Groups)(?:\/([^/]+))?$/

const writeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

const readBearerToken = (request: Request) => request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]

const tokenKey = (token: string) => `token:${createHash('sha256').update(token).digest('hex')}`

const parseObject = (text: string): ScimJson | undefined => {
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as ScimJson) : undefined
  } catch {
    return undefined
  }
}

const withBody = (request: Request, body: string | undefined) => {
  const headers = new Headers(request.headers)
  headers.delete('content-length')
  return new Request(request.url, { method: request.method, headers, body, signal: request.signal })
}

/** Body to send on, or the response to answer with instead. */
type Prepared = { body: ScimJson } | { response: Response }

type ScimRequestHandlerDeps = {
  /** Better Auth's request handler. */
  handler: (request: Request) => Promise<Response>
  database: typeof DbType
  rateLimit: RateLimitSettings
  limits?: ScimRateLimits
  /** A lock all backend instances share (Postgres); without it, writes are serialized per process only. */
  sharedLock?: KeyedLock
}

/**
 * Every SCIM request, between the Elysia mount and the plugin:
 * 1. the rate limit: a per-credential budget, plus a per-IP budget that only rejected
 *    credentials spend. Refusals are SCIM 429s with `Retry-After`.
 * 2. for writes, one at a time per resource, provider requests are normalized and checked
 *    (`normalize.ts`), then sent, and sent again while they lose an optimistic-lock race.
 *
 * PATCH and PUT on a user first read the stored user through the plugin with the caller's own
 * token, so the read is authenticated and scoped to the caller's connection.
 */
export const createScimRequestHandler = ({
  handler,
  database,
  rateLimit,
  limits = defaultScimRateLimits,
  sharedLock,
}: ScimRequestHandlerDeps) => {
  const credentialLimit = createRateLimitConsumer(database, rateLimit, 'scim', limits.perCredential)
  const authFailureLimit = createFailureRateLimit(database, rateLimit, 'scim-auth-failure', limits.authFailuresPerIp)
  const lock = createKeyedLock()

  /** The stored resource, whole: never with the caller's query, which could project `externalId` away. */
  const readResource = (request: Request) => {
    const { origin, pathname } = new URL(request.url)
    const headers = new Headers(request.headers)
    headers.delete('content-type')
    headers.delete('content-length')
    return handler(new Request(`${origin}${pathname}`, { method: 'GET', headers, signal: request.signal }))
  }

  const prepareUserPatch = async (request: Request, body: ScimJson, operations: ScimPatchOperation[]) => {
    const stored = await readResource(request)
    if (stored.status !== 200) {
      return { response: stored }
    }
    const current = (await stored.clone().json()) as { externalId?: string; emails?: { value: string }[] }
    const refusal = guardExternalIdPatch(operations, current.externalId)
    if (refusal) {
      return { response: refusalResponse(refusal) }
    }
    const rewritten = rewriteEmailValueFilters(operations, current.emails ?? [])
    if ('refusal' in rewritten) {
      return { response: refusalResponse(rewritten.refusal) }
    }
    return rewritten.operations.length === 0
      ? { response: stored }
      : { body: { ...body, Operations: rewritten.operations } }
  }

  const prepare = async (request: Request, type: string, id: string | undefined, body: ScimJson): Promise<Prepared> => {
    if (request.method === 'POST') {
      const refusal = type === 'Users' ? requireExternalId(body) : undefined
      return refusal ? { response: refusalResponse(refusal) } : { body: stripUnsupportedExtensions(body) }
    }
    if (request.method === 'PUT') {
      if (type === 'Groups') {
        return { body: stripUnsupportedExtensions(body) }
      }
      const stored = await readResource(request)
      if (stored.status !== 200) {
        return { response: stored }
      }
      const current = (await stored.json()) as { externalId?: string }
      const guarded = guardExternalIdPut(stripUnsupportedExtensions(body), current.externalId)
      return 'refusal' in guarded ? { response: refusalResponse(guarded.refusal) } : { body: guarded.resource }
    }
    if (!Array.isArray(body.Operations) || id === undefined) {
      return { body }
    }
    const operations = stripUnsupportedExtensionOperations(body.Operations as ScimPatchOperation[])
    if (type === 'Users') {
      return prepareUserPatch(request, body, operations)
    }
    return operations.length === 0
      ? { response: await readResource(request) }
      : { body: { ...body, Operations: operations } }
  }

  const write = async (request: Request, type: string, id: string | undefined) => {
    const text = request.method === 'DELETE' ? undefined : await request.text()
    const body = text === undefined ? undefined : parseObject(text)
    // Malformed bodies go on untouched, for the plugin to answer.
    if (!body) {
      return sendRetryingConcurrentConflicts(() => handler(withBody(request, text)))
    }
    // Each attempt prepares afresh: a retry follows a write that changed the stored resource,
    // so a body built from the first read would undo it.
    return sendRetryingConcurrentConflicts(async () => {
      const prepared = await prepare(request, type, id, body)
      return 'response' in prepared ? prepared.response : handler(withBody(request, JSON.stringify(prepared.body)))
    })
  }

  const route = (request: Request) => {
    const match = resourcePath.exec(new URL(request.url).pathname)
    if (!match || !writeMethods.has(request.method)) {
      return handler(request)
    }
    const [, type, id] = match
    if (!id) {
      return write(request, type, id)
    }
    const key = `${type}:${id}`
    const send = () => write(request, type, id)
    // A user PATCH writes an email list built from its own read, which a write on another instance
    // in between would undo, so the read and the write hold a lock every instance shares.
    const guarded =
      sharedLock && type === 'Users' && request.method === 'PATCH' ? () => sharedLock(`scim:${key}`, send) : send
    return lock(key, guarded)
  }

  return async (request: Request, clientIp: string): Promise<Response> => {
    const set: RateLimitSet = { headers: {} }
    const ipKey = `ip:${clientIp}`
    const token = readBearerToken(request)
    // Only resource routes authenticate. Discovery answers anyone, so charging a bucket there would
    // let any caller write a rate-limit row per made-up token without ever earning a 401.
    const chargesCredential = token !== undefined && resourcePath.test(new URL(request.url).pathname)
    const limited =
      (await authFailureLimit?.check(ipKey, set)) ??
      (chargesCredential ? await credentialLimit?.(tokenKey(token), set) : undefined)
    if (limited) {
      return scimErrorResponse(
        429,
        'Too many SCIM requests; retry after the Retry-After interval',
        undefined,
        set.headers,
      )
    }
    const response = await route(request)
    if (response.status === 401) {
      await authFailureLimit?.record(ipKey)
    }
    return response
  }
}
